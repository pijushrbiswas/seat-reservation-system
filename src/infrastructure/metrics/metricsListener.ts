import type { EventBus } from "../events/eventBus.js";
import type { Metrics } from "./metrics.js";

/**
 * Subscribes the Prometheus counters to the domain events, so services never call the metrics library.
 * @param events - Bus the services publish to.
 * @param metrics - Counters to update.
 */
export function attachMetricsListeners(events: EventBus, metrics: Metrics): void {
  events.on("reservation.confirmed", () => metrics.confirmed.inc());
  events.on("reservation.replayed", () => metrics.declined.inc({ reason: "idempotent_replay" }));
  events.on("reservation.declined", (reason) => metrics.declined.inc({ reason }));
  events.on("reservation.cancelled", () => metrics.cancelled.inc());
  events.on("cache.declined", () => metrics.cacheDeclines.inc());
  events.on("cache.error", () => metrics.cacheErrors.inc());
}
