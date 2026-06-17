// Built-in cloud delivery. Custom delivery doesn't go through a sink module —
// the user writes `dif/events/{exposure,track}.ts` directly.

export { cloudSink, cloudTrack } from "./cloud.js";
