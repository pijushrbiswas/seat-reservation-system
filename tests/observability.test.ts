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
  it("liveness is ok and readiness checks the database", async () => {
    expect((await t.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    const ready = await t.app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.database).toBe("ok");
  });

  it("readiness fails closed when the database is unreachable", async () => {
    const broken = await makeApp();
    // Point the readiness pool at a dead port.
    const { createHealthPool } = await import("../src/db.js");
    const dead = createHealthPool({ ...broken.config, databaseUrl: "postgres://seats:seats@127.0.0.1:1/seats" });
    broken.ctx.healthPool = dead;
    const ready = await broken.app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.database).toBe("down");
    expect((await broken.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
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
