import { Composition } from "remotion";
import props from "../props.json";
import { Demo } from "./Demo";
import type { StudioProps } from "./types";

// The file is the timeline of the last build; render.mjs passes the same file as inputProps.
const defaults = props as StudioProps;
const frames = (p: StudioProps) => Math.max(1, Math.ceil((p.durationMs / 1000) * p.fps));

export const Root = () => (
  <Composition
    id="Demo"
    component={Demo}
    durationInFrames={frames(defaults)}
    fps={defaults.fps}
    width={defaults.width}
    height={defaults.height}
    defaultProps={defaults}
    calculateMetadata={({ props }) => ({ durationInFrames: frames(props), fps: props.fps, width: props.width, height: props.height })}
  />
);
