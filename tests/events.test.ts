import { describe, expect, it } from "vitest";
import { EventBus } from "../src/infrastructure/events/eventBus.js";

describe("event bus", () => {
  it("delivers the event arguments to every subscriber", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on("reservation.declined", (reason) => seen.push(`a:${reason}`));
    bus.on("reservation.declined", (reason) => seen.push(`b:${reason}`));
    bus.emit("reservation.declined", "seat_taken");
    expect(seen).toEqual(["a:seat_taken", "b:seat_taken"]);
  });

  it("a failing subscriber never breaks the code that emitted the event", () => {
    const bus = new EventBus();
    bus.on("reservation.confirmed", () => {
      throw new Error("observer bug");
    });
    expect(() => bus.emit("reservation.confirmed")).not.toThrow();
  });
});
