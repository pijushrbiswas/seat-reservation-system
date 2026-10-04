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

  it("reports an unknown label even when another requested seat is taken, and leaks nothing (Postgres alone decides)", async () => {
    const pgOnly = await makeApp({ REDIS_ENABLED: "false" });
    try {
      const show = await pgOnly.createShow(["A1", "A2", "A3"]);
      const [a, b] = [await pgOnly.token("alice"), await pgOnly.token("bob")];
      expect((await pgOnly.reserve(a, show.id, ["A2"], "mix-a")).status).toBe(201);
      const mixed = await pgOnly.reserve(b, show.id, ["A1", "A2", "Z9"], "mix-b");
      expect(mixed.status).toBe(422);
      expect(mixed.body.error).toMatchObject({ code: "unknown_seat", seats: ["Z9"] });
      const taken = await pgOnly.reserve(b, show.id, ["A1", "A2"], "mix-c");
      expect(taken.status).toBe(409);
      expect(taken.body.error).toMatchObject({ code: "seat_taken", seats: ["A2"] });
      expect(await pgOnly.show(show.id)).toMatchObject({ available: 2, confirmed: 1 });
    } finally {
      await pgOnly.close();
    }
  });

  it("with Redis off, Postgres alone still sells each seat once under a stampede, with overlapping multi-seat requests", async () => {
    const pgOnly = await makeApp({ REDIS_ENABLED: "false" });
    try {
      const show = await pgOnly.createShow(seatNames("S", 10), { per_user_limit: 4 });
      const users = await Promise.all(Array.from({ length: 120 }, (_, i) => pgOnly.token(`stampede-${i}`)));
      const results = await Promise.all(
        users.map((tok, i) => pgOnly.reserve(tok, show.id, [`S${(i % 10) + 1}`, `S${((i + 1) % 10) + 1}`], `stampede-${i}`)),
      );
      expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
      const won = results.filter((r) => r.status === 201);
      const seats = won.flatMap((r) => r.body.seats as string[]);
      expect(new Set(seats).size).toBe(seats.length);
      const after = await pgOnly.show(show.id);
      expect(after.confirmed).toBe(seats.length);
      assertReconciled(after);
    } finally {
      await pgOnly.close();
    }
  });

  it("gives the quota back when a request is declined, so the user can still reserve up to the limit", async () => {
    const show = await t.createShow(seatNames("Q", 6), { per_user_limit: 2 });
    const [a, b] = [await t.token("alice"), await t.token("bob")];
    expect((await t.reserve(a, show.id, ["Q1"], "quota-a")).status).toBe(201);
    const declined = await t.reserve(b, show.id, ["Q1", "Q2"], "quota-b1");
    expect(declined.status).toBe(409);
    expect((await t.reserve(b, show.id, ["Q2", "Q3"], "quota-b2")).status).toBe(201);
    expect((await t.reserve(b, show.id, ["Q4"], "quota-b3")).body.error.code).toBe("per_user_limit");
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
    expect((await t.reserve(a, show.id, ["A2"], "aon-a")).status).toBe(201);
    const partial = await t.reserve(b, show.id, ["A1", "A2", "A3"], "aon-b");
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

describe("per-user limit", () => {
  it("declines a single request above the limit with 409 per_user_limit", async () => {
    const show = await t.createShow(seatNames("L", 10), { per_user_limit: 4 });
    const tok = await t.token("greedy");
    const r = await t.reserve(tok, show.id, seatNames("L", 5), "k");
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("per_user_limit");
    expect((await t.show(show.id)).confirmed).toBe(0);
  });

  it("counts across requests", async () => {
    const show = await t.createShow(seatNames("L", 10), { per_user_limit: 4 });
    const tok = await t.token("steady");
    expect((await t.reserve(tok, show.id, ["L1", "L2", "L3"], "k1")).status).toBe(201);
    const over = await t.reserve(tok, show.id, ["L4", "L5"], "k2");
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("per_user_limit");
    expect((await t.reserve(tok, show.id, ["L4"], "k3")).status).toBe(201);
    expect((await t.reserve(tok, show.id, ["L5"], "k4")).body.error.code).toBe("per_user_limit");
    // The failed attempts must not have leaked seats or quota.
    const after = await t.show(show.id);
    expect(after.confirmed).toBe(4);
    assertReconciled(after);
  });

  it("10 parallel reserves by one user on limit=4 end with at most 4 held", async () => {
    const show = await t.createShow(seatNames("P", 20), { per_user_limit: 4 });
    const tok = await t.token("stampeder");
    const results = await Promise.all(seatNames("P", 10).map((seat, i) => t.reserve(tok, show.id, [seat], `par-${i}`)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(4);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === "per_user_limit")).toHaveLength(6);
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    const after = await t.show(show.id);
    expect(after.confirmed).toBe(4);
    assertReconciled(after);
  });

  it("many users each firing parallel reserves: nobody exceeds the limit", async () => {
    const show = await t.createShow(seatNames("Q", 100), { per_user_limit: 4 });
    const users = await Promise.all(Array.from({ length: 10 }, (_, i) => t.token(`multi-${i}`)));
    const results = await Promise.all(
      users.flatMap((tok, u) =>
        seatNames("Q", 100)
          .slice(u * 10, u * 10 + 10)
          .map((seat, i) => t.reserve(tok, show.id, [seat], `m-${u}-${i}`)),
      ),
    );
    const perUser = new Map<string, number>();
    for (const r of results.filter((x) => x.status === 201)) {
      perUser.set(r.body.user_id, (perUser.get(r.body.user_id) ?? 0) + 1);
    }
    expect(perUser.size).toBe(10);
    for (const n of perUser.values()) expect(n).toBe(4);
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("a retry with the same key returns the original reservation and moves nothing", async () => {
    const show = await t.createShow(seatNames("I", 5));
    const tok = await t.token("retrier");
    const first = await t.reserve(tok, show.id, ["I1"], "same-key");
    const retry = await t.reserve(tok, show.id, ["I1"], "same-key");
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    const after = await t.show(show.id);
    expect(after.confirmed).toBe(1);
  });

  it("the same key with different seats is rejected with 409", async () => {
    const show = await t.createShow(seatNames("I", 5));
    const tok = await t.token("confused");
    expect((await t.reserve(tok, show.id, ["I1"], "k")).status).toBe(201);
    const bad = await t.reserve(tok, show.id, ["I2"], "k");
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("idempotency_key_conflict");
    expect((await t.show(show.id)).confirmed).toBe(1);
  });

  it("seat order and duplicates do not change the request identity", async () => {
    const show = await t.createShow(seatNames("I", 5));
    const tok = await t.token("orderly");
    const a = await t.reserve(tok, show.id, ["I2", "I1"], "k");
    const b = await t.reserve(tok, show.id, ["I1", "I2", "I1"], "k");
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.reservation_id).toBe(a.body.reservation_id);
  });

  it("50 parallel requests with one key create exactly one reservation", async () => {
    const show = await t.createShow(seatNames("I", 5));
    const tok = await t.token("doubleclick");
    const results = await Promise.all(Array.from({ length: 50 }, () => t.reserve(tok, show.id, ["I3", "I4"], "burst-key")));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.reservation_id)).size).toBe(1);
    const after = await t.show(show.id);
    expect(after.confirmed).toBe(2);
  });

  it("parallel same key, different seats: one winner, the rest 409", async () => {
    const show = await t.createShow(seatNames("I", 10));
    const tok = await t.token("mixed");
    const results = await Promise.all(
      seatNames("I", 10).map((seat) => t.reserve(tok, show.id, [seat], "shared-key")),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    expect((await t.show(show.id)).confirmed).toBe(1);
  });

  it("keys are scoped per user", async () => {
    const show = await t.createShow(seatNames("I", 5));
    const [a, b] = [await t.token("u-a"), await t.token("u-b")];
    expect((await t.reserve(a, show.id, ["I1"], "shared")).status).toBe(201);
    const other = await t.reserve(b, show.id, ["I2"], "shared");
    expect(other.status).toBe(201);
    expect(other.body.user_id).toBe("u-b");
  });

  it("a declined request does not consume its key", async () => {
    const show = await t.createShow(["I1"]);
    const [a, b] = [await t.token("holder"), await t.token("waiter")];
    expect((await t.reserve(a, show.id, ["I1"], "ka")).status).toBe(201);
    expect((await t.reserve(b, show.id, ["I1"], "kb")).status).toBe(409);
    const again = await t.reserve(b, show.id, ["I1"], "kb");
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("seat_taken");
  });

  it("accepts the key via the Idempotency-Key header and rejects a missing key", async () => {
    const show = await t.createShow(seatNames("I", 3));
    const tok = await t.token("header-user");
    const headers = { authorization: `Bearer ${tok}`, "idempotency-key": t.key("hdr-1") };
    const one = await t.app.inject({ method: "POST", url: `/shows/${show.id}/reserve`, headers, payload: { seats: ["I1"] } });
    const two = await t.app.inject({ method: "POST", url: `/shows/${show.id}/reserve`, headers, payload: { seats: ["I1"] } });
    expect(one.statusCode).toBe(201);
    expect(two.statusCode).toBe(200);
    expect(two.headers["idempotent-replayed"]).toBe("true");
    const none = await t.app.inject({
      method: "POST",
      url: `/shows/${show.id}/reserve`,
      headers: { authorization: `Bearer ${tok}` },
      payload: { seats: ["I2"] },
    });
    expect(none.statusCode).toBe(400);
  });

  it("a replay still works when the user is at their limit", async () => {
    const show = await t.createShow(seatNames("I", 6), { per_user_limit: 2 });
    const tok = await t.token("capped");
    const first = await t.reserve(tok, show.id, ["I1", "I2"], "k");
    expect(first.status).toBe(201);
    expect((await t.reserve(tok, show.id, ["I1", "I2"], "k")).status).toBe(200);
  });
});
