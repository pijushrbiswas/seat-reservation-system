import { EventEmitter } from "node:events";
import type { DeclineReason } from "../../common/errors.js";

/**
 * Domain events the services announce. Services describe what happened; listeners (metrics today, anything
 * else tomorrow) decide what to do about it, so business code never touches the metrics library.
 */
export interface DomainEvents {
  /** A new reservation was confirmed. */
  "reservation.confirmed": [];
  /** A retry with a known idempotency key got the original reservation back. */
  "reservation.replayed": [];
  /** A reserve request was refused cleanly, with the reason. */
  "reservation.declined": [reason: DeclineReason];
  /** A reservation was cancelled by its owner. */
  "reservation.cancelled": [];
  /** Redis turned a request away without it reaching Postgres. */
  "cache.declined": [];
  /** A Redis call failed and the request fell through to Postgres. */
  "cache.error": [];
}

/**
 * A small typed publish/subscribe bus. Emitting is synchronous and a failing listener never breaks the
 * request that emitted the event.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  /**
   * Subscribes to an event.
   * @param event - Event name.
   * @param listener - Called with the event's arguments each time it is emitted.
   */
  on<K extends keyof DomainEvents>(event: K, listener: (...args: DomainEvents[K]) => void): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  /**
   * Announces an event to every subscriber.
   * @param event - Event name.
   * @param args - The event's arguments.
   */
  emit<K extends keyof DomainEvents>(event: K, ...args: DomainEvents[K]): void {
    try {
      this.emitter.emit(event, ...args);
    } catch {
      // Observers must never fail a request.
    }
  }
}
