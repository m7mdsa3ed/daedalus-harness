/* ── Office files, as a page ──
   `.docx`, `.xlsx` and `.pptx` are zips of XML; the browser draws none of them.
   Each becomes an HTML string for a frame with an empty `sandbox` (no scripts,
   no origin), so what a document contains — a link, an embedded style — can do
   nothing. Parsers are lazy chunks: a transcript that never previews one never
   pays for them.

   Word keeps headings, lists, tables and images. Excel keeps each cell's font,
   fill, borders, alignment, merges and column widths, and carries the formula
   beside the value — a checkbox in the page (CSS `:has`, no script) swaps them.
   PowerPoint is not HTML here: `pptx-preview` draws slides into a live DOM, so
   `renderSlides` takes the frame's body instead.
   ponytail: no charts or conditional formatting in Excel, and the theme colours
   Excel stores by index are not resolved (those cells keep the default).
   `.doc`/`.xls`/`.ppt` (pre-2007) are not zips and are not handled. */

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

const STYLE = `<style>
body{font:14px/1.6 system-ui,sans-serif;margin:0;padding:24px;color:#1f2328;background:#fff}
table{border-collapse:collapse;margin:8px 0;table-layout:fixed}td,th{padding:2px 6px;vertical-align:bottom;overflow:hidden;border:1px solid #e5e8eb}
img{max-width:100%}h2.sheet{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#57606a;margin:24px 0 4px}
.f{display:none;font-family:ui-monospace,monospace;font-size:12px}
body:has(#showf:checked) .v{display:none}body:has(#showf:checked) .f{display:inline}
label{font-size:12px;color:#57606a;cursor:pointer}
</style>`

const page = (body: string) => `<!doctype html><meta charset="utf-8">${STYLE}${body}`

export async function officeHtml(bytes: ArrayBuffer, ext: string): Promise<string> {
  if (ext === "docx") {
    const mammoth = await import("mammoth")
    return page((await mammoth.convertToHtml({ arrayBuffer: bytes })).value)
  }
  return xlsxHtml(bytes)
}

const MAX_ROWS = 1000
const MAX_COLS = 80

const hex = (c?: { argb?: string }) => (c?.argb && c.argb.length >= 6 ? `#${c.argb.slice(-6)}` : undefined)

function cellCss(cell: import("exceljs").Cell): string {
  const { font, fill, alignment, border } = cell.style
  const css: string[] = []
  if (font?.bold) css.push("font-weight:600")
  if (font?.italic) css.push("font-style:italic")
  if (font?.underline) css.push("text-decoration:underline")
  if (font?.size) css.push(`font-size:${font.size}pt`)
  if (hex(font?.color)) css.push(`color:${hex(font?.color)}`)
  if (fill?.type === "pattern" && fill.pattern === "solid" && hex(fill.fgColor)) css.push(`background:${hex(fill.fgColor)}`)
  if (alignment?.horizontal) css.push(`text-align:${alignment.horizontal === "centerContinuous" ? "center" : alignment.horizontal}`)
  else if (typeof cell.value === "number") css.push("text-align:right")
  if (alignment?.vertical) css.push(`vertical-align:${alignment.vertical === "middle" ? "middle" : alignment.vertical}`)
  css.push(alignment?.wrapText ? "white-space:pre-wrap" : "white-space:nowrap")
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const b = border?.[side]
    if (b?.style) css.push(`border-${side}:${b.style === "medium" || b.style === "thick" ? 2 : 1}px ${b.style === "dashed" ? "dashed" : b.style === "dotted" ? "dotted" : "solid"} ${hex(b.color) ?? "#000"}`)
  }
  return css.join(";")
}

/** `A1` -> [row, col], 1-based. */
function addr(a: string): [number, number] {
  const m = /^([A-Z]+)(\d+)$/.exec(a)!
  return [Number(m[2]), [...m[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)]
}

async function xlsxHtml(bytes: ArrayBuffer): Promise<string> {
  const { default: ExcelJS } = await import("exceljs")
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes)
  const out: string[] = [`<label><input type="checkbox" id="showf"> Show formulas</label>`]
  for (const ws of wb.worksheets) {
    if (ws.state !== "visible") continue
    const rows = Math.min(ws.rowCount, MAX_ROWS)
    const cols = Math.min(ws.columnCount, MAX_COLS)
    /* Merges: the top-left cell carries the span, the rest are not drawn. */
    const span = new Map<string, [number, number]>()
    const covered = new Set<string>()
    for (const range of (ws.model.merges ?? []) as string[]) {
      const [tl, br] = range.split(":") as [string, string]
      const [r1, c1] = addr(tl)
      const [r2, c2] = addr(br)
      span.set(`${r1},${c1}`, [r2 - r1 + 1, c2 - c1 + 1])
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) covered.add(`${r},${c}`)
    }
    const colgroup = Array.from({ length: cols }, (_, i) => {
      const col = ws.getColumn(i + 1)
      return col.hidden ? "" : `<col style="width:${Math.round((col.width ?? 8.43) * 7 + 5)}px">`
    }).join("")
    const body: string[] = []
    for (let r = 1; r <= rows; r++) {
      const row = ws.getRow(r)
      if (row.hidden) continue
      const tds: string[] = []
      for (let c = 1; c <= cols; c++) {
        if (ws.getColumn(c).hidden || covered.has(`${r},${c}`)) continue
        const cell = row.getCell(c)
        const [rs, cs] = span.get(`${r},${c}`) ?? [1, 1]
        const formula = (cell.value as { formula?: string } | null)?.formula
        const text = esc(cell.text)
        tds.push(
          `<td${rs > 1 ? ` rowspan="${rs}"` : ""}${cs > 1 ? ` colspan="${cs}"` : ""} style="${cellCss(cell)}">${
            formula ? `<span class="v">${text}</span><span class="f">=${esc(formula)}</span>` : text
          }</td>`,
        )
      }
      body.push(`<tr style="height:${Math.round((row.height ?? 15) * 1.33)}px">${tds.join("")}</tr>`)
    }
    const clipped = ws.rowCount > rows || ws.columnCount > cols ? `<p><em>Showing the first ${rows} rows and ${cols} columns.</em></p>` : ""
    out.push(`<h2 class="sheet">${esc(ws.name)}</h2><table><colgroup>${colgroup}</colgroup>${body.join("")}</table>${clipped}`)
  }
  return page(out.join(""))
}

/** Slides drawn into `body` (a frame's, so the app's CSS cannot reach them).
    Returns what to call on unmount. */
export async function renderSlides(body: HTMLElement, bytes: ArrayBuffer, width: number): Promise<() => void> {
  const { init } = await import("pptx-preview")
  const previewer = init(body, { width, height: Math.round((width * 9) / 16), mode: "list" })
  await previewer.preview(bytes)
  return () => previewer.destroy()
}

const MAX_CSV_ROWS = 5000

/** A CSV/TSV as a table, first row as the header. RFC 4180 quoting (`""`, quoted
    newlines); the delimiter is a tab for `.tsv`, else the more frequent of `,`
    and `;` on the first line. ponytail: no encoding sniffing — UTF-8 in, as the
    text route reads it. */
export function csvHtml(text: string, tsv: boolean): string {
  const first = text.slice(0, text.search(/\r?\n|$/))
  const sep = tsv ? "\t" : (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ","
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  const src = text.replace(/^\uFEFF/, "")
  for (let i = 0; i < src.length && rows.length <= MAX_CSV_ROWS; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch !== '"') cell += ch
      else if (src[i + 1] === '"') (cell += '"'), i++
      else quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === sep) (row.push(cell), (cell = ""))
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++
      row.push(cell)
      rows.push(row)
      ;(row = []), (cell = "")
    } else cell += ch
  }
  if (cell || row.length) rows.push([...row, cell])
  const clipped = rows.length > MAX_CSV_ROWS
  const [head = [], ...body] = rows.slice(0, MAX_CSV_ROWS)
  const td = (tag: string) => (v: string) => `<${tag} style="white-space:pre-wrap">${esc(v)}</${tag}>`
  return page(
    `<table style="table-layout:auto"><thead><tr>${head.map(td("th")).join("")}</tr></thead><tbody>${body
      .map((r) => `<tr>${r.map(td("td")).join("")}</tr>`)
      .join("")}</tbody></table>${clipped ? `<p><em>Showing the first ${MAX_CSV_ROWS} rows.</em></p>` : ""}`,
  )
}
