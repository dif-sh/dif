// Custom mode sends page and identify elements to the app's handlers.
// A missing handler drops the element with one console.debug.

import type { ElementSink } from "./elements.js";
import type { EventsConfig } from "./types.js";

type Custom = Extract<EventsConfig, { mode: "custom" }>;

export function customElementSink(events: Custom): ElementSink {
  const warned = new Set<string>();
  const drop = (type: string): void => {
    if (warned.has(type) || typeof console === "undefined") return;
    warned.add(type);
    console.debug(`[dif] no ${type} handler in custom events: ${type} dropped.`);
  };
  return (element) => {
    if (element.type === "page") {
      if (events.page) events.page(element);
      else drop("page");
    } else if (element.type === "identify") {
      if (events.identify) events.identify(element);
      else drop("identify");
    }
  };
}
