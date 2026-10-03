import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, seatNames, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => {
  await t.close();
});

async function metrics(): Promise<string> {
  return (await t.app.inject({ method: "GET", url: "/metrics" })).body;
}

function sample(text: string, name: string, labels = ""): number {
  const re = new RegExp(`^${name}${labels ? `\\{${labels}\\}` : ""} (\\S+)$`, "m");
  const m = re.exec(text);
  if (!m) throw new Error(`metric not found: ${name}${labels}`);
  return Number(m[1]);
}

describe("health", () => {
  it("one endpoint: liveness probe is ok, and the default probe checks the database", async () => {
    const live = await t.app.inject({ method: "GET", url: "/health?probe=live" });
    expect(live.statusCode).toBe(200);
    expect(live.json().status).toBe("alive");
    const ready = await t.app.inject({ method: "GET", url: "/health" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.database).toBe("ok");
  });

  it("readiness fails closed when the database is unreachable", async () => {
    const broken = await makeApp();
    // Point the readiness pool at a dead port.
    const { createReadinessPool } = await import("../src/infrastructure/database/connection.js");
    const dead = createReadinessPool({ ...broken.config, databaseUrl: "postgres://seats:seats@127.0.0.1:1/seats" });
    broken.ctx.healthPool = dead;
    const ready = await broken.app.inject({ method: "GET", url: "/health" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.database).toBe("down");
    expect((await broken.app.inject({ method: "GET", url: "/health?probe=live" })).statusCode).toBe(200);
    await dead.end();
    await broken.close();
  });
});

describe("metrics reconcile with API behaviour", () => {
  it("counters move by exactly the observed outcomes", async () => {
    const before = await metrics();
    const show = await t.createShow(seatNames("M", 6), { per_user_limit: 2 });
    const [a, b] = [await t.token("m-a"), await t.token("m-b")];

    expect((await t.reserve(a, show.id, ["M1"], "k1")).status).toBe(201); // confirmed
    expect((await t.reserve(a, show.id, ["M1"], "k1")).status).toBe(200); // idempotent_replay
    expect((await t.reserve(b, show.id, ["M1"], "k2")).status).toBe(409); // seat_taken
    expect((await t.reserve(a, show.id, ["M2", "M3"], "k3")).status).toBe(409); // per_user_limit
    expect((await t.reserve(a, show.id, ["M4"], "k1")).status).toBe(409); // idempotency_key_conflict

    // Seat gauges are read from Postgres with a 1s scrape cache.
    await new Promise((r) => setTimeout(r, 1100));
    const after = await metrics();
    const delta = (name: string, labels = "") => sample(after, name, labels) - sample(before, name, labels);
    expect(delta("reservations_confirmed_total")).toBe(1);
    expect(delta("reservations_declined_total", 'reason="idempotent_replay"')).toBe(1);
    expect(delta("reservations_declined_total", 'reason="seat_taken"')).toBe(1);
    expect(delta("reservations_declined_total", 'reason="per_user_limit"')).toBe(1);
    expect(delta("reservations_declined_total", 'reason="idempotency_key_conflict"')).toBe(1);

    expect(sample(after, "seats_available", `show_id="${show.id}"`)).toBe(5);
    expect(sample(after, "seats_confirmed", `show_id="${show.id}"`)).toBe(1);
    expect(sample(after, "seats_reconciliation_drift", `show_id="${show.id}"`)).toBe(0);
  });

  it("structured logs carry the request id and are served from /logs", async () => {
    const res = await t.app.inject({ method: "GET", url: "/shows/00000000-0000-4000-8000-000000000000", headers: { "x-request-id": "corr-123" } });
    expect(res.headers["x-request-id"]).toBe("corr-123");
    const logs = await t.app.inject({ method: "GET", url: "/logs?request_id=corr-123" });
    expect(logs.statusCode).toBe(200);
  });
});

describe("GET /stats", () => {
  it("prints one readable line per show with available, held and confirmed together", async () => {
    const show = await t.createShow(["Z1", "Z2", "Z3"]);
    const tok = await t.token("stats-user");
    expect((await t.reserve(tok, show.id, ["Z1"], "k")).status).toBe(201);
    await new Promise((r) => setTimeout(r, 1100));
    const text = await t.app.inject({ method: "GET", url: "/stats" });
    expect(text.headers["content-type"]).toContain("text/plain");
    expect(text.body).toContain(`show="test-show" id=${show.id} total=3 available=2 held=0 confirmed=1 drift=0`);
    const json = (await t.app.inject({ method: "GET", url: "/stats?format=json" })).json();
    expect(json.shows.find((s: { show_id: string }) => s.show_id === show.id)).toMatchObject({
      total: 3,
      available: 2,
      held: 0,
      confirmed: 1,
      drift: 0,
    });
  });
});

describe("GET /logs limit", () => {
  it("accepts a limit up to the configured buffer size and rejects anything larger", async () => {
    const max = t.ctx.config.logBufferLines;
    expect((await t.app.inject({ method: "GET", url: `/logs?limit=${max}` })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: `/logs?limit=${max + 1}` })).statusCode).toBe(400);
  });
});

describe("health check logging", () => {
  it("does not log a successful /health poll, but still counts it in the metrics", async () => {
    const loud = await makeApp({ LOG_LEVEL: "info" });
    try {
      const id = `health-quiet-${Date.now()}`;
      const res = await loud.app.inject({ method: "GET", url: "/health", headers: { "x-request-id": id } });
      expect(res.statusCode).toBe(200);
      // Positive control: a normal request with the same logger IS logged, so the absence below is meaningful.
      const other = await loud.app.inject({ method: "GET", url: "/shows/not-a-uuid", headers: { "x-request-id": `${id}-control` } });
      expect(other.statusCode).toBe(404);
      const lines = loud.ctx.ring.getRecentLines();
      expect(lines.some((l) => l.includes(`${id}-control`))).toBe(true);
      expect(lines.some((l) => l.includes(`"${id}"`))).toBe(false);
      const metrics = await loud.ctx.metrics.registry.metrics();
      expect(metrics).toMatch(/http_requests_total\{method="GET",route="\/health",status="200"\} \d+/);
    } finally {
      await loud.close();
    }
  });
});

describe("correlation id", () => {
  it("is taken from x-correlation-id, echoed back, logged on every line, and kept apart from the per-call request id", async () => {
    const loud = await makeApp({ LOG_LEVEL: "info" });
    try {
      const corr = `flow-${Date.now()}`;
      const tok = await loud.token("corr-user");
      const call = (reqId: string) =>
        loud.app.inject({
          method: "POST",
          url: "/shows/00000000-0000-4000-8000-000000000000/reserve",
          headers: { authorization: `Bearer ${tok}`, "x-correlation-id": corr, "x-request-id": reqId },
          payload: { seats: ["A1"], idempotency_key: `corr-${reqId}` },
        });
      const [first, second] = [await call(`${corr}-a`), await call(`${corr}-b`)];
      expect(first.headers["x-correlation-id"]).toBe(corr);
      expect(first.headers["x-request-id"]).toBe(`${corr}-a`);
      expect(first.json().error).toMatchObject({ request_id: `${corr}-a`, correlation_id: corr });
      expect(second.headers["x-correlation-id"]).toBe(corr);

      const lines = loud.ctx.ring.getRecentLines().map((l) => JSON.parse(l)).filter((l) => l.correlation_id === corr);
      expect(lines).toHaveLength(2);
      expect(lines.map((l) => l.request_id).sort()).toEqual([`${corr}-a`, `${corr}-b`]);

      const viaApi = await loud.app.inject({ method: "GET", url: `/logs?correlation_id=${corr}` });
      expect(viaApi.body.trim().split("\n")).toHaveLength(2);
    } finally {
      await loud.close();
    }
  });

  it("is generated when the caller sends none, and differs from the request id", async () => {
    const res = await t.app.inject({ method: "GET", url: "/shows/not-a-uuid" });
    const corr = res.headers["x-correlation-id"] as string;
    expect(corr).toMatch(/^[0-9a-f-]{36}$/);
    expect(corr).not.toBe(res.headers["x-request-id"]);
    expect(res.json().error.correlation_id).toBe(corr);
  });

  it("ignores an unsafe x-correlation-id and generates a fresh one", async () => {
    const res = await t.app.inject({ method: "GET", url: "/shows/not-a-uuid", headers: { "x-correlation-id": "bad value with spaces!" } });
    expect(res.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("metrics cover every show", () => {
  const statsLines = async (app: TestApp) => (await app.app.inject({ method: "GET", url: "/stats" })).body.trim().split("\n");

  it("reports more than the old limit of 20 shows, newest first", async () => {
    const all = await makeApp();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 25; i++) ids.push((await all.createShow([`S${i}`])).id);
      const body = (await all.app.inject({ method: "GET", url: "/stats" })).body;
      for (const id of ids) expect(body).toContain(`id=${id} `);
      expect(body.indexOf(`id=${ids[24]} `)).toBeLessThan(body.indexOf(`id=${ids[0]} `));
      const gauges = await all.ctx.metrics.registry.metrics();
      for (const id of ids) expect(gauges).toContain(`seats_available{show_id="${id}"} 1`);
    } finally {
      await all.close();
    }
  });

  it("METRICS_MAX_SHOWS limits how many of the newest shows are reported", async () => {
    const capped = await makeApp({ METRICS_MAX_SHOWS: "3" });
    try {
      for (let i = 0; i < 5; i++) await capped.createShow([`C${i}`]);
      expect(await statsLines(capped)).toHaveLength(3);
    } finally {
      await capped.close();
    }
  });

  it("shows seats held in Redis for the right show when many shows are read at once", async () => {
    const a = await t.createShow(["A1", "A2"]);
    const b = await t.createShow(["B1", "B2"]);
    const c = await t.createShow(["C1"]);
    await t.ctx.cache.tryHoldSeats(a.id, ["A1"], "tok-a");
    await t.ctx.cache.tryHoldSeats(b.id, ["B1", "B2"], "tok-b");
    const held = await t.ctx.cache.listHeldSeatsForShows([a.id, b.id, c.id]);
    expect(held[0]).toEqual(["A1"]);
    expect([...held[1]!].sort()).toEqual(["B1", "B2"]);
    expect(held[2]).toEqual([]);
    expect(await t.ctx.cache.listHeldSeatsForShows([])).toEqual([]);
  });
});
