import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertReconciled, makeApp, seatNames, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => {
  await t.close();
});

describe("reserve", () => {
  it("confirms a free seat and charges integer paise", async () => {
    const show = await t.createShow(["A1", "A2"], { price_paise: 25000 });
    const tok = await t.token("alice");
    const r = await t.reserve(tok, show.id, ["A1"], "k1");
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      show_id: show.id,
      user_id: "alice",
      seats: ["A1"],
      amount_paise: 25000,
      status: "confirmed",
    });
    expect(r.body.reservation_id).toBeTruthy();
    const after = await t.show(show.id);
    expect(after).toMatchObject({ available: 1, confirmed: 1, held: 0 });
    expect(after.seats).toEqual([
      { seat: "A1", status: "confirmed" },
      { seat: "A2", status: "available" },
    ]);
  });

  it("declines a taken seat with a clean 409, never a second copy", async () => {
    const show = await t.createShow(["A1"]);
    const [a, b] = [await t.token("alice"), await t.token("bob")];
    expect((await t.reserve(a, show.id, ["A1"], "ka")).status).toBe(201);
    const second = await t.reserve(b, show.id, ["A1"], "kb");
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("seat_taken");
    expect(second.body.error.seats).toEqual(["A1"]);
  });

  it("rejects unknown seats and unknown shows cleanly", async () => {
    const show = await t.createShow(["A1"]);
    const tok = await t.token("alice");
    const unknownSeat = await t.reserve(tok, show.id, ["Z9"], "k");
    expect(unknownSeat.status).toBe(422);
    expect(unknownSeat.body.error.code).toBe("unknown_seat");
    const unknownShow = await t.reserve(tok, "00000000-0000-4000-8000-000000000000", ["A1"], "k");
    expect(unknownShow.status).toBe(404);
  });

  it("requires a valid token", async () => {
    const show = await t.createShow(["A1"]);
    const none = await t.app.inject({ method: "POST", url: `/shows/${show.id}/reserve`, payload: { seats: ["A1"] } });
    expect(none.statusCode).toBe(401);
    const bad = await t.app.inject({
      method: "POST",
      url: `/shows/${show.id}/reserve`,
      headers: { authorization: "Bearer not.a.jwt" },
      payload: { seats: ["A1"] },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("is all-or-nothing for multi-seat requests", async () => {
    const show = await t.createShow(["A1", "A2", "A3"]);
    const [a, b] = [await t.token("alice"), await t.token("bob")];
    expect((await t.reserve(a, show.id, ["A2"], "ka")).status).toBe(201);
    const partial = await t.reserve(b, show.id, ["A1", "A2", "A3"], "kb");
    expect(partial.status).toBe(409);
    expect(partial.body.error.seats).toEqual(["A2"]);
    const after = await t.show(show.id);
    // A1 and A3 must still be available: nothing from the failed request leaked.
    expect(after.seats?.map((s) => s.status)).toEqual(["available", "confirmed", "available"]);
  });
});

describe("reserve under concurrency", () => {
  it("hot seat: 500 users race for A12 -> exactly one 201, 499 x 409, zero 5xx", async () => {
    const show = await t.createShow(seatNames("A", 20));
    const tokens = await Promise.all(Array.from({ length: 500 }, (_, i) => t.token(`hot-${i}`)));
    const results = await Promise.all(tokens.map((tok, i) => t.reserve(tok, show.id, ["A12"], `hot-${i}`)));

    const wins = results.filter((r) => r.status === 201);
    const losses = results.filter((r) => r.status === 409);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(499);
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    expect(losses.every((r) => r.body.error.code === "seat_taken")).toBe(true);

    const after = await t.show(show.id);
    assertReconciled(after);
    expect(after.confirmed).toBe(1);
  });

  it("opposite-order multi-seat requests do not deadlock and never double-sell", async () => {
    const show = await t.createShow(seatNames("B", 6));
    const tokens = await Promise.all(Array.from({ length: 200 }, (_, i) => t.token(`md-${i}`)));
    const forward = ["B1", "B2", "B3", "B4"];
    const reverse = [...forward].reverse();
    const results = await Promise.all(
      tokens.map((tok, i) => t.reserve(tok, show.id, i % 2 === 0 ? forward : reverse, `md-${i}`)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(199);
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    const after = await t.show(show.id);
    assertReconciled(after);
    expect(after.confirmed).toBe(4);
  });

  it("overlapping multi-seat requests never confirm the same seat twice", async () => {
    const seats = seatNames("C", 12);
    const show = await t.createShow(seats);
    const tokens = await Promise.all(Array.from({ length: 300 }, (_, i) => t.token(`ov-${i}`)));
    const results = await Promise.all(
      tokens.map((tok, i) => {
        const start = i % 10;
        return t.reserve(tok, show.id, [seats[start]!, seats[start + 1]!, seats[start + 2]!], `ov-${i}`);
      }),
    );
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    const won = results.filter((r) => r.status === 201).flatMap((r) => r.body.seats as string[]);
    expect(new Set(won).size).toBe(won.length);
    const after = await t.show(show.id);
    assertReconciled(after);
    expect(after.confirmed).toBe(won.length);
  });
});
