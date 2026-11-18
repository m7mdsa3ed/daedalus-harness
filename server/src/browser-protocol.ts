/**
 * The browser panel's wire contract (docs/plans/browser.md), written once and
 * compiled into both halves: the server directly, the client through the
 * `@daedalus/browser-protocol` alias, like `compat.ts`. This file is types plus
 * the frame header's encode/decode. It imports nothing and uses only
 * `DataView`, `Uint8Array` and `TextEncoder`/`TextDecoder`, which exist in Node
 * and the browser alike.
 *
 * Three surfaces:
 *   - the viewer socket `/browser?projectId=&token=[&sessionId=]`: binary
 *     screencast frames and JSON state go server->client, JSON commands go
 *     client->server.
 *   - REST: `GET/POST /api/projects/:id/browser/tabs`,
 *     `DELETE /api/projects/:id/browser/tabs/:tabId`, and `GET /api/browser/status`.
 *   - the feature names `browserPanel` / `browserMcp` in `compat.ts`.
 *
 * **Every coordinate and size is in CSS pixels** of the tab's viewport. The
 * client maps a canvas pointer into CSS pixels using the frame metadata
 * (`deviceWidth`/`deviceHeight` are the CSS size the JPEG depicts), and the
 * server forwards CSS pixels to CDP `Input.*` unchanged.
 *
 * **State messages are absolute, never deltas.** Each one replaces what the
 * client held for that key, so a viewer that joins late or misses a message is
 * correct after the next one. On open the server sends `hello`, then `tabs`,
 * `front`, and for every tab any pending `dialog`, any current `agent`
 * activity and the `viewport`, then the cached last frame of the front tab.
 */

/** Bumped on any change to the binary header or a breaking change to the JSON
    shapes. Said in `hello` and in byte 0 of every frame. */
export const BROWSER_PROTOCOL_VERSION = 1;

/** Socket path, beside `/terminal`. Query: `projectId` (required), `token`
    (the bearer, required), `sessionId` (optional: the thread whose dock holds
    this panel, so the agent's default tab can follow the tab in front of it). */
export const BROWSER_SOCKET_PATH = "/browser";

/** Close codes the server ends a viewer socket with. Anything else (1006, no
    code) is a dropped connection, and the client reconnects on its own. */
export const BROWSER_CLOSE = {
  /** The project's browser was shut down (idle sweep, project delete, server
      shutdown). Reconnecting relaunches it. */
  closed: 4000,
  /** Bad or missing token. */
  unauthorized: 4001,
  /** No Chrome on this server (see `GET /api/browser/status`). Do not retry. */
  unavailable: 4003,
  /** No such project. Do not retry. */
  notFound: 4004,
  /** `MAX_BROWSERS` are running and none could be evicted. */
  limit: 4029,
} as const;
export type BrowserCloseCode = (typeof BROWSER_CLOSE)[keyof typeof BROWSER_CLOSE];

// ---------------------------------------------------------------------------
// Shared value shapes
// ---------------------------------------------------------------------------

/** A tab id is the CDP `targetId` (an opaque string, 32 hex chars today). */
export type BrowserTabId = string;

export interface BrowserTab {
  id: BrowserTabId;
  url: string;
  title: string;
  /** Absolute URL of the page's icon, or null when it has none (yet). */
  favicon: string | null;
  /** True from navigation start until the settle wait says the page is done. */
  loading: boolean;
  openedBy: { kind: "user" } | { kind: "agent"; sessionId: string };
}

/** A rectangle in CSS pixels of the tab's viewport. */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A JavaScript dialog the page is blocked on. While one is pending the page
    renders nothing new; the panel draws it as a sheet. */
export interface BrowserDialog {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  /** The page's suggested answer, `prompt` only. */
  defaultValue?: string;
}

/** The verbs an agent's tool call is drawn with. */
export type BrowserAgentAction =
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "click"
  | "dblclick"
  | "hover"
  | "fill"
  | "type"
  | "press"
  | "select"
  | "scroll"
  | "drag"
  | "dialog"
  | "snapshot"
  | "screenshot"
  | "evaluate"
  | "wait_for"
  | "viewport"
  | "tabs";

/** What an agent is doing in a tab, for the overlay: a ring on `rect` and a
    "<agent> is driving" badge naming `sessionId`'s thread. */
export interface BrowserAgentActivity {
  sessionId: string;
  tabId: BrowserTabId;
  action: BrowserAgentAction;
  /** The element acted on, CSS pixels; null for an action with no element. */
  rect: BrowserRect | null;
  /** Epoch ms the action started. */
  at: number;
}

/** CDP `Input.*` modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export const BROWSER_MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

/** The bitmask for a DOM event's modifier flags (a `KeyboardEvent`,
    `PointerEvent` or `WheelEvent` all carry these four). */
export function browserModifiers(e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (e.altKey ? BROWSER_MODIFIER.alt : 0) |
    (e.ctrlKey ? BROWSER_MODIFIER.ctrl : 0) |
    (e.metaKey ? BROWSER_MODIFIER.meta : 0) |
    (e.shiftKey ? BROWSER_MODIFIER.shift : 0)
  );
}

export type BrowserMouseButton = "none" | "left" | "middle" | "right" | "back" | "forward";

// ---------------------------------------------------------------------------
// Binary frames (server -> client)
// ---------------------------------------------------------------------------

/**
 * One screencast frame per binary WebSocket message: a header, then the JPEG
 * bytes to the end of the message. All numbers are **little-endian**.
 *
 * ```
 * offset size  type  field
 *      0    1  u8    version          = BROWSER_PROTOCOL_VERSION
 *      1    1  u8    kind             = BROWSER_FRAME_KIND.screencast
 *      2    2  u16   headerLength     bytes from offset 0 to the first JPEG byte
 *      4    4  u32   seq              per-tab frame counter, wraps at 2^32
 *      8    8  f64   timestamp        CDP metadata.timestamp, seconds since epoch (0 if absent)
 *     16    4  f32   offsetTop        CSS px, CDP metadata.offsetTop
 *     20    4  f32   pageScaleFactor  CDP metadata.pageScaleFactor
 *     24    4  f32   deviceWidth      CSS px the image depicts, CDP metadata.deviceWidth
 *     28    4  f32   deviceHeight     CSS px the image depicts, CDP metadata.deviceHeight
 *     32    4  f32   scrollOffsetX    CSS px, CDP metadata.scrollOffsetX
 *     36    4  f32   scrollOffsetY    CSS px, CDP metadata.scrollOffsetY
 *     40    2  u16   tabIdLength      bytes of the UTF-8 tab id that follows
 *     42    n  utf8  tabId
 *   42+n    -  bytes JPEG             to the end of the message
 * ```
 *
 * A decoder must read `headerLength` rather than assume `42 + n`, so a later
 * version can append fields before the JPEG without breaking an older reader
 * of the same `version`. The client should set `binaryType = "arraybuffer"`.
 */
export const BROWSER_FRAME_KIND = { screencast: 1 } as const;

/** Bytes before the tab id. */
const FIXED_HEADER = 42;

export interface BrowserFrameHeader {
  tabId: BrowserTabId;
  seq: number;
  timestamp: number;
  offsetTop: number;
  pageScaleFactor: number;
  deviceWidth: number;
  deviceHeight: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
}

export interface BrowserFrame {
  header: BrowserFrameHeader;
  /** A view into the message, not a copy. */
  jpeg: Uint8Array;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Header + JPEG as one message body. The server passes CDP's base64 `data`
    decoded to bytes (e.g. `Buffer.from(data, "base64")`). */
export function encodeBrowserFrame(header: BrowserFrameHeader, jpeg: Uint8Array): Uint8Array {
  const id = utf8Encoder.encode(header.tabId);
  if (id.length > 0xffff) throw new Error("browser frame: tab id too long");
  const headerLength = FIXED_HEADER + id.length;
  const out = new Uint8Array(headerLength + jpeg.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, BROWSER_PROTOCOL_VERSION);
  view.setUint8(1, BROWSER_FRAME_KIND.screencast);
  view.setUint16(2, headerLength, true);
  view.setUint32(4, header.seq >>> 0, true);
  view.setFloat64(8, header.timestamp, true);
  view.setFloat32(16, header.offsetTop, true);
  view.setFloat32(20, header.pageScaleFactor, true);
  view.setFloat32(24, header.deviceWidth, true);
  view.setFloat32(28, header.deviceHeight, true);
  view.setFloat32(32, header.scrollOffsetX, true);
  view.setFloat32(36, header.scrollOffsetY, true);
  view.setUint16(40, id.length, true);
  out.set(id, FIXED_HEADER);
  out.set(jpeg, headerLength);
  return out;
}

/** Null for anything that is not a frame this build can read: too short, a
    different `version`, an unknown `kind`, or lengths that overrun. */
export function decodeBrowserFrame(data: ArrayBuffer | Uint8Array): BrowserFrame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < FIXED_HEADER) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== BROWSER_PROTOCOL_VERSION) return null;
  if (view.getUint8(1) !== BROWSER_FRAME_KIND.screencast) return null;
  const headerLength = view.getUint16(2, true);
  const idLength = view.getUint16(40, true);
  if (FIXED_HEADER + idLength > headerLength || headerLength > bytes.length) return null;
  return {
    header: {
      tabId: utf8Decoder.decode(bytes.subarray(FIXED_HEADER, FIXED_HEADER + idLength)),
      seq: view.getUint32(4, true),
      timestamp: view.getFloat64(8, true),
      offsetTop: view.getFloat32(16, true),
      pageScaleFactor: view.getFloat32(20, true),
      deviceWidth: view.getFloat32(24, true),
      deviceHeight: view.getFloat32(28, true),
      scrollOffsetX: view.getFloat32(32, true),
      scrollOffsetY: view.getFloat32(36, true),
    },
    jpeg: bytes.subarray(headerLength),
  };
}

// ---------------------------------------------------------------------------
// JSON messages (server -> client)
// ---------------------------------------------------------------------------

/** First message on every socket. `viewerId` names this socket in later
    messages (for example `viewport.ownerViewerId`). */
export interface BrowserHelloMessage {
  type: "hello";
  version: number;
  viewerId: string;
  /** `browser.version()`, e.g. "Chrome/151.0.7922.137". */
  browserVersion: string;
}

/** Every open tab, in strip order. Absolute. */
export interface BrowserTabsMessage {
  type: "tabs";
  tabs: BrowserTab[];
}

/** The tab in front of *this* viewer, the one whose frames it receives.
    Null when the browser has no tabs. Absolute, and per viewer. */
export interface BrowserFrontMessage {
  type: "front";
  tabId: BrowserTabId | null;
}

/** The dialog a tab is blocked on, or null once it is answered. Absolute per
    tab. Fanned to every viewer, whichever tab is in front of it. */
export interface BrowserDialogMessage {
  type: "dialog";
  tabId: BrowserTabId;
  dialog: BrowserDialog | null;
}

/** An agent's current action in a tab, or null when it finished. Absolute per
    tab. Fanned to every viewer. */
export interface BrowserAgentMessage {
  type: "agent";
  tabId: BrowserTabId;
  activity: BrowserAgentActivity | null;
}

/** The tab's emulated viewport, CSS pixels. `owner` says who set it: a viewer
    (the panel that last had input, `ownerViewerId`) or an agent's `viewport`
    tool call, which wins until a person resizes or resets. A panel whose size
    differs letterboxes. Absolute per tab. */
export interface BrowserViewportMessage {
  type: "viewport";
  tabId: BrowserTabId;
  width: number;
  height: number;
  dpr: number;
  owner: { kind: "viewer"; viewerId: string } | { kind: "agent"; sessionId: string };
}

export type BrowserErrorCode =
  /** The command did not parse or named a field wrongly. */
  | "bad_command"
  /** The command named a tab that does not exist (any more). */
  | "no_tab"
  /** The navigation failed (DNS, refused, aborted); `message` is Chrome's text. */
  | "navigation_failed"
  /** Chrome could not be launched or crashed; the next command relaunches. */
  | "browser_failed"
  | "internal";

/** A command failed. Live only; never changes state on its own (the absolute
    messages that follow say what is true). */
export interface BrowserErrorMessage {
  type: "error";
  code: BrowserErrorCode;
  message: string;
  /** The `type` of the command that failed, when one did. */
  command?: BrowserCommand["type"];
  tabId?: BrowserTabId;
}

export type BrowserServerMessage =
  | BrowserHelloMessage
  | BrowserTabsMessage
  | BrowserFrontMessage
  | BrowserDialogMessage
  | BrowserAgentMessage
  | BrowserViewportMessage
  | BrowserErrorMessage;

// ---------------------------------------------------------------------------
// JSON commands (client -> server)
// ---------------------------------------------------------------------------

/** Load a URL in a tab. The client has already turned typed text into a URL
    (a search URL, or `https://` assumed). */
export interface BrowserNavigateUrlCommand {
  type: "navigate";
  tabId: BrowserTabId;
  action: "url";
  url: string;
}

export interface BrowserNavigateHistoryCommand {
  type: "navigate";
  tabId: BrowserTabId;
  action: "back" | "forward" | "reload" | "stop";
}

export type BrowserNavigateCommand = BrowserNavigateUrlCommand | BrowserNavigateHistoryCommand;

/** Open a tab (about:blank without `url`); it becomes this viewer's front tab. */
export interface BrowserTabNewCommand {
  type: "tab";
  action: "new";
  url?: string;
}

/** Close a tab; a viewer whose front tab it was is moved to a neighbour. */
export interface BrowserTabCloseCommand {
  type: "tab";
  action: "close";
  tabId: BrowserTabId;
}

/** Bring a tab to the front for this viewer and for the browser (CDP
    `bringToFront`), which also makes it the agent's default tab for this
    viewer's thread. `watch` is the quieter form. */
export interface BrowserTabSelectCommand {
  type: "tab";
  action: "select";
  tabId: BrowserTabId;
}

export type BrowserTabCommand = BrowserTabNewCommand | BrowserTabCloseCommand | BrowserTabSelectCommand;

/** The panel's canvas size in CSS pixels and the device pixel ratio. Sent
    debounced on resize and with the first input after one. It sizes the
    viewer's front tab and caps the screencast at width x dpr / height x dpr. */
export interface BrowserViewportCommand {
  type: "viewport";
  width: number;
  height: number;
  dpr: number;
}

/** Maps to CDP `Input.dispatchMouseEvent`. The sub-type is `event`, because
    `type` is the command's discriminator. */
export interface BrowserMouseCommand {
  type: "mouse";
  tabId: BrowserTabId;
  event: "mousePressed" | "mouseReleased" | "mouseMoved";
  x: number;
  y: number;
  button: BrowserMouseButton;
  /** DOM `buttons` bitmask of buttons held down. */
  buttons: number;
  /** 1 for a click, 2 for the second press of a double click. */
  clickCount: number;
  /** `BROWSER_MODIFIER` bitmask. */
  modifiers: number;
}

/** Maps to CDP `Input.dispatchMouseEvent` with `type: "mouseWheel"`. Deltas
    in CSS pixels (a DOM `WheelEvent` in line or page mode is converted by the
    client). */
export interface BrowserWheelCommand {
  type: "wheel";
  tabId: BrowserTabId;
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  modifiers: number;
}

/** Maps to CDP `Input.dispatchKeyEvent`. `key`/`code` are the DOM
    `KeyboardEvent` values; `text` is what a printable key inserts (absent for
    Enter-less control keys, arrows, chords). The server sends `keyDown` with
    `text` as `keyDown` and without it as `rawKeyDown`. Composed text (IME,
    paste) does not come this way: it is a `text` command. */
export interface BrowserKeyCommand {
  type: "key";
  tabId: BrowserTabId;
  event: "keyDown" | "keyUp";
  key: string;
  code: string;
  /** `BROWSER_MODIFIER` bitmask. */
  modifiers: number;
  text?: string;
  /** DOM `keyCode`, passed to CDP as `windowsVirtualKeyCode`. */
  keyCode?: number;
  /** DOM `location` (0 standard, 1 left, 2 right, 3 numpad). */
  location?: number;
  repeat?: boolean;
}

/** Insert text at the focus (CDP `Input.insertText`): an IME commit or a paste. */
export interface BrowserTextCommand {
  type: "text";
  tabId: BrowserTabId;
  text: string;
}

/** Answer the tab's pending dialog. `promptText` only for a `prompt`. */
export interface BrowserDialogCommand {
  type: "dialog";
  tabId: BrowserTabId;
  accept: boolean;
  promptText?: string;
}

/** Stream this tab's frames to this viewer without bringing it to the front
    for anyone else; null stops frames to this viewer (a hidden panel). The
    server answers with `front`. */
export interface BrowserWatchCommand {
  type: "watch";
  tabId: BrowserTabId | null;
}

export type BrowserCommand =
  | BrowserNavigateCommand
  | BrowserTabCommand
  | BrowserViewportCommand
  | BrowserMouseCommand
  | BrowserWheelCommand
  | BrowserKeyCommand
  | BrowserTextCommand
  | BrowserDialogCommand
  | BrowserWatchCommand;

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------
// Failures use the server's usual `{ error: string }` body. A project's
// browser is launched lazily by POST and by the socket, never by GET.

/** `GET /api/projects/:id/browser/tabs`. `running: false` means no Chrome is
    up for the project right now; `tabs` are then the ones `tabs.json` will
    reopen on the next launch. */
export interface BrowserTabsResponse {
  running: boolean;
  tabs: BrowserTab[];
}

/** `POST /api/projects/:id/browser/tabs` body. Launches the browser if needed. */
export interface BrowserTabCreateRequest {
  url?: string;
}

/** `POST /api/projects/:id/browser/tabs` answer. */
export interface BrowserTabCreateResponse {
  tab: BrowserTab;
}

/** `DELETE /api/projects/:id/browser/tabs/:tabId` answer. 404 for an unknown tab. */
export interface BrowserTabDeleteResponse {
  ok: true;
}

/** `GET /api/browser/status`. Measured, never assumed: `version` comes from
    launching it (`browser.version()`), not a parsed `--version`. */
export type BrowserStatusResponse =
  | { available: true; version: string; executablePath: string }
  | { available: false; reason: string };

/** The REST paths, spelled once. */
export const browserPaths = {
  status: "/api/browser/status",
  tabs: (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/browser/tabs`,
  tab: (projectId: string, tabId: BrowserTabId) =>
    `/api/projects/${encodeURIComponent(projectId)}/browser/tabs/${encodeURIComponent(tabId)}`,
} as const;
