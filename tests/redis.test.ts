import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertReconciled, makeApp, seatNames, type TestApp } from "./helpers.js";

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6380";

let t: TestApp;
let raw: Redis;
beforeAll(async () => {
  t = await makeApp();
  raw = new Redis(REDIS_URL);
});
afterAll(async () => {
  raw.disconnect();
  await t.close();
});

const counter = async (app: TestApp, name: "cacheDeclines" | "cacheErrors") =>
  (await app.ctx.metrics[name].get()).values[0]?.value ?? 0;

describe("redis front line", () => {
  it("is actually connected", () => {
    expect(t.ctx.cache.connectionStatus()).toBe("ok");
  });

  it("hot seat: 499 losers are declined by Redis and never reach Postgres", async () => {
    const show = await t.createShow(seatNames("A", 20));
    const tokens = await Promise.all(Array.from({ length: 500 }, (_, i) => t.token(`rh-${i}`)));
    const before = await counter(t, "cacheDeclines");
    const results = await Promise.all(tokens.map((tok, i) => t.reserve(tok, show.id, ["A12"], `rh-${i}`)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === "seat_taken")).toHaveLength(499);
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    expect((await counter(t, "cacheDeclines")) - before).toBe(499);
    const after = await t.show(show.id);
    assertReconciled(after);
    expect(after.confirmed).toBe(1);
  });

  it("a multi-seat request is all-or-nothing in Redis too: no lease leaks from a declined request", async () => {
    const show = await t.createShow(["A1", "A2", "A3"]);
    const [a, b, c] = [await t.token("mo-a"), await t.token("mo-b"), await t.token("mo-c")];
    expect((await t.reserve(a, show.id, ["A2"], "k")).status).toBe(201);
    const partial = await t.reserve(b, show.id, ["A1", "A2", "A3"], "k");
    expect(partial.status).toBe(409);
    expect(partial.body.error.seats).toEqual(["A2"]);
    // A1 and A3 must be immediately bookable: the failed request left nothing behind.
    expect((await t.reserve(c, show.id, ["A1", "A3"], "k")).status).toBe(201);
  });

  it("releases the lease when Postgres declines (per-user limit), so the seat is bookable at once", async () => {
    const show = await t.createShow(seatNames("L", 5), { per_user_limit: 1 });
    const [a, b] = [await t.token("lim-a"), await t.token("lim-b")];
    expect((await t.reserve(a, show.id, ["L1"], "k1")).status).toBe(201);
    expect((await t.reserve(a, show.id, ["L2"], "k2")).body.error.code).toBe("per_user_limit");
    const other = await t.reserve(b, show.id, ["L2"], "k3");
    expect(other.status).toBe(201);
  });

  it("cancel clears the marker: the seat is re-bookable immediately and by Postgres, not the cache", async () => {
    const show = await t.createShow(["A1"]);
    const [a, b] = [await t.token("cx-a"), await t.token("cx-b")];
    const r = await t.reserve(a, show.id, ["A1"], "k");
    expect(await raw.get(`seat:{${show.id}}:A1`)).toBe(`C|${r.body.reservation_id}`);
    await t.cancel(a, r.body.reservation_id);
    expect(await raw.get(`seat:{${show.id}}:A1`)).toBeNull();
    expect((await t.reserve(b, show.id, ["A1"], "k")).status).toBe(201);
  });

  it("a cancel never clears a marker that belongs to a newer reservation", async () => {
    const show = await t.createShow(["A1"]);
    const [a, b] = [await t.token("nc-a"), await t.token("nc-b")];
    const r1 = await t.reserve(a, show.id, ["A1"], "k");
    await t.cancel(a, r1.body.reservation_id);
    const r2 = await t.reserve(b, show.id, ["A1"], "k");
    await t.cancel(a, r1.body.reservation_id); // repeated cancel is a no-op
    expect(await raw.get(`seat:{${show.id}}:A1`)).toBe(`C|${r2.body.reservation_id}`);
  });

  it("a retried key still replays after the seat was cancelled and re-sold", async () => {
    const show = await t.createShow(["A1"]);
    const [a, b] = [await t.token("rp-a"), await t.token("rp-b")];
    const r1 = await t.reserve(a, show.id, ["A1"], "k");
    await t.cancel(a, r1.body.reservation_id);
    expect((await t.reserve(b, show.id, ["A1"], "k")).status).toBe(201);
    const replay = await t.reserve(a, show.id, ["A1"], "k");
    expect(replay.status).toBe(200);
    expect(replay.body.reservation_id).toBe(r1.body.reservation_id);
  });
});

describe("redis is an accelerator, never the authority", () => {
  it("a flushed Redis cannot cause a double-sell: Postgres still declines", async () => {
    const show = await t.createShow(["A1"]);
    const [a, b, c] = [await t.token("fl-a"), await t.token("fl-b"), await t.token("fl-c")];
    expect((await t.reserve(a, show.id, ["A1"], "k")).status).toBe(201);
    await raw.flushall();
    const before = await counter(t, "cacheDeclines");
    const second = await t.reserve(b, show.id, ["A1"], "k");
    expect(second.status).toBe(409);
    expect(await counter(t, "cacheDeclines")).toBe(before); // Postgres made this decision
    // ...and it re-primed the cache, so the next loser is turned away by Redis.
    expect((await t.reserve(c, show.id, ["A1"], "k")).status).toBe(409);
    expect(await counter(t, "cacheDeclines")).toBe(before + 1);
  });

  it("a replay that reaches Postgres after Redis forgot the key leaves no hold behind", async () => {
    const show = await t.createShow(["A1"]);
    const [a, b] = [await t.token("rf-a"), await t.token("rf-b")];
    const r1 = await t.reserve(a, show.id, ["A1"], "k");
    await t.cancel(a, r1.body.reservation_id);
    await raw.flushall(); // Redis forgets the idempotency key, so the retry takes a fresh hold
    const replay = await t.reserve(a, show.id, ["A1"], "k");
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe("cancelled");
    expect(await raw.get(`seat:{${show.id}}:A1`)).toBeNull();
    expect((await t.show(show.id)).held).toBe(0);
    expect((await t.reserve(b, show.id, ["A1"], "k2")).status).toBe(201);
  });

  it("a flush mid-storm still produces exactly one winner per seat", async () => {
    const show = await t.createShow(seatNames("S", 10));
    const tokens = await Promise.all(Array.from({ length: 400 }, (_, i) => t.token(`fs-${i}`)));
    const flusher = (async () => {
      for (let i = 0; i < 20; i++) {
        await raw.flushall();
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    const results = await Promise.all(tokens.map((tok, i) => t.reserve(tok, show.id, [`S${(i % 10) + 1}`], `fs-${i}`)));
    await flusher;
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    const after = await t.show(show.id);
    assertReconciled(after);
    expect(after.confirmed).toBe(10);
  });

  it("a stale 'taken' marker heals itself after its TTL", async () => {
    const quick = await makeApp({ SEAT_CACHE_TTL_SECONDS: "1" });
    try {
      const show = await quick.createShow(["A1"]);
      const tok = await quick.token("stale");
      // Simulate a missed invalidation: Redis says taken, Postgres says available.
      await raw.set(`seat:{${show.id}}:A1`, "C|ghost", "EX", 1);
      expect((await quick.reserve(tok, show.id, ["A1"], "k1")).status).toBe(409);
      await new Promise((r) => setTimeout(r, 1200));
      expect((await quick.reserve(tok, show.id, ["A1"], "k2")).status).toBe(201);
    } finally {
      await quick.close();
    }
  });

  it("with Redis unreachable the service degrades to Postgres: correct, zero 5xx, readiness still ready", async () => {
    const down = await makeApp({ REDIS_URL: "redis://127.0.0.1:1" });
    try {
      expect(down.ctx.cache.connectionStatus()).toBe("down");
      const show = await down.createShow(seatNames("A", 20));
      const tokens = await Promise.all(Array.from({ length: 300 }, (_, i) => down.token(`dn-${i}`)));
      const results = await Promise.all(tokens.map((tok, i) => down.reserve(tok, show.id, ["A12"], `dn-${i}`)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(299);
      expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
      assertReconciled(await down.show(show.id));
      expect(await counter(down, "cacheErrors")).toBeGreaterThan(0);
      const ready = await down.app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks.redis).toBe("down");
    } finally {
      await down.close();
    }
  });
});

describe("held state lives in Redis and expires on its own", () => {
  it("the request that wins the Redis lock is the only one that reaches Postgres", async () => {
    const show = await t.createShow(["A1", "A2"]);
    const tok = await t.token("hold-win");
    const other = await t.token("hold-lose");
    // Simulate a winner that holds A1 and has not finished confirming yet.
    expect((await t.ctx.cache.tryHoldSeats(show.id, ["A1"], "winner-token")).kind).toBe("acquired");

    const mid = await t.show(show.id);
    expect(mid).toMatchObject({ available: 1, held: 1, confirmed: 0, reconciled: true });
    expect(mid.seats).toEqual([
      { seat: "A1", status: "held" },
      { seat: "A2", status: "available" },
    ]);
    expect((await t.show(show.id, false)).held).toBe(1);
    const rows = await t.ctx.pool.query(`SELECT status FROM seats WHERE show_id = $1 AND label = 'A1'`, [show.id]);
    expect(rows.rows[0].status).toBe("available"); // Postgres never stores the hold

    const before = await counter(t, "cacheDeclines");
    const loser = await t.reserve(other, show.id, ["A1"], "k");
    expect(loser.status).toBe(409);
    expect(loser.body.error.code).toBe("seat_taken");
    expect(await counter(t, "cacheDeclines")).toBe(before + 1);
    expect((await t.reserve(tok, show.id, ["A2"], "k")).status).toBe(201);
    assertReconciled(await t.show(show.id));
  });

  it("an abandoned hold expires by itself and the seat is bookable again", async () => {
    const quick = await makeApp({ SEAT_HOLD_SECONDS: "1" });
    try {
      const show = await quick.createShow(["A1"]);
      const tok = await quick.token("hold-exp");
      await quick.ctx.cache.tryHoldSeats(show.id, ["A1"], "dead-request"); // winner that never confirms
      expect((await quick.show(show.id)).held).toBe(1);
      expect((await quick.reserve(tok, show.id, ["A1"], "k1")).status).toBe(409);
      await new Promise((r) => setTimeout(r, 1200));
      const after = await quick.show(show.id);
      expect(after).toMatchObject({ available: 1, held: 0, confirmed: 0 });
      expect((await quick.reserve(tok, show.id, ["A1"], "k2")).status).toBe(201);
    } finally {
      await quick.close();
    }
  });

  it("a confirmed seat is confirmed, never also held", async () => {
    const show = await t.createShow(["A1", "A2"]);
    const tok = await t.token("hold-conf");
    expect((await t.reserve(tok, show.id, ["A1"], "k")).status).toBe(201);
    expect(await raw.zscore(`held:{${show.id}}`, "A1")).toBeNull();
    expect(await t.show(show.id)).toMatchObject({ available: 1, held: 0, confirmed: 1, reconciled: true });
  });

  it("a declined winner gives its hold back immediately", async () => {
    const show = await t.createShow(["L1", "L2"], { per_user_limit: 1 });
    const a = await t.token("hold-lim");
    expect((await t.reserve(a, show.id, ["L1"], "k1")).status).toBe(201);
    expect((await t.reserve(a, show.id, ["L2"], "k2")).body.error.code).toBe("per_user_limit");
    expect(await raw.zscore(`held:{${show.id}}`, "L2")).toBeNull();
    expect(await raw.get(`seat:{${show.id}}:L2`)).toBeNull();
    expect((await t.show(show.id)).held).toBe(0);
  });

  it("holds appear in the seats_held gauge and the invariant still reconciles", async () => {
    const show = await t.createShow(["A1", "A2", "A3"]);
    await t.ctx.cache.tryHoldSeats(show.id, ["A1", "A2"], "gauge-token");
    await new Promise((r) => setTimeout(r, 1100)); // gauges are cached for 1s
    const text = await t.ctx.metrics.registry.metrics();
    expect(text).toContain(`seats_held{show_id="${show.id}"} 2`);
    expect(text).toContain(`seats_available{show_id="${show.id}"} 1`);
    expect(text).toContain(`seats_reconciliation_drift{show_id="${show.id}"} 0`);
  });

  it("with Redis off there is no held state and the service still reconciles", async () => {
    const off = await makeApp({ REDIS_ENABLED: "false" });
    try {
      const show = await off.createShow(["A1"]);
      expect(await off.show(show.id)).toMatchObject({ available: 1, held: 0, confirmed: 0, reconciled: true });
    } finally {
      await off.close();
    }
  });
});
