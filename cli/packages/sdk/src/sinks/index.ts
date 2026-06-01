// Public re-exports of bundled sinks. Customers can also implement their own
// — anything matching the `Sink` interface.

export { cloudSink } from "./cloud.js";
export { webhookSink } from "./webhook.js";
export { segmentSink } from "./segment.js";
export { amplitudeSink } from "./amplitude.js";
export { mixpanelSink } from "./mixpanel.js";
