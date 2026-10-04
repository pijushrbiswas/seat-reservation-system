import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ADMIN_TOKEN, makeApp, seatNames, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => {
  await t.close();
});

describe("POST /shows", () => {
  it("creates a show with every seat available", async () => {
    const show = await t.createShow(["A1", "A2", "A3"], { price_paise: 25000 });
    expect(show.id).toBeTruthy();
    expect(show.total_seats).toBe(3);
    expect(show.price_paise).toBe(25000);
    expect(show.per_user_limit).toBe(4);
    expect(show.available).toBe(3);
    expect(show.seats).toEqual([
      { seat: "A1", status: "available" },
      { seat: "A2", status: "available" },
      { seat: "A3", status: "available" },
    ]);
  });

  it("requires admin credentials", async () => {
    const anon = await t.app.inject({ method: "POST", url: "/shows", payload: { name: "x", seats: ["A1"], price_paise: 1 } });
    expect(anon.statusCode).toBe(401);
    const userToken = await t.token("alice");
    const asUser = await t.app.inject({
      method: "POST",
      url: "/shows",
      headers: { authorization: `Bearer ${userToken}` },
      payload: { name: "x", seats: ["A1"], price_paise: 1 },
    });
    expect(asUser.statusCode).toBe(403);
  });

  it.each([
    ["float price", { name: "x", seats: ["A1"], price_paise: 10.5 }],
    ["duplicate seats", { name: "x", seats: ["A1", "A1"], price_paise: 1 }],
    ["no seats", { name: "x", seats: [], price_paise: 1 }],
    ["negative price", { name: "x", seats: ["A1"], price_paise: -1 }],
    ["bad seat label", { name: "x", seats: ["A 1"], price_paise: 1 }],
  ])("rejects %s with 400", async (_name, body) => {
    const res = await t.app.inject({
      method: "POST",
      url: "/shows",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("invalid_request");
  });
});

describe("GET /shows/:id", () => {
  it("returns per-seat status and reconciling counts", async () => {
    const show = await t.createShow(seatNames("B", 50));
    const got = await t.show(show.id);
    expect(got.total_seats).toBe(50);
    expect(got.available + got.held + got.confirmed).toBe(50);
    expect(got.seats).toHaveLength(50);
    const noSeats = await t.show(show.id, false);
    expect(noSeats.seats).toBeUndefined();
    expect(noSeats.available).toBe(50);
  });

  it("404s for unknown or malformed ids", async () => {
    expect((await t.app.inject({ url: "/shows/00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
    expect((await t.app.inject({ url: "/shows/not-a-uuid" })).statusCode).toBe(404);
  });
});

describe("request ids", () => {
  it("echoes a caller-supplied id and generates one otherwise", async () => {
    const a = await t.app.inject({ url: "/health?probe=live", headers: { "x-request-id": "abc-123" } });
    expect(a.headers["x-request-id"]).toBe("abc-123");
    const b = await t.app.inject({ url: "/health?probe=live" });
    expect(b.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("GET /shows/:id with the short read cache on", () => {
  it("serves repeated reads from the cache but reflects this instance's own reserve and cancel at once", async () => {
    const c = await makeApp({ SHOW_STATE_CACHE_MS: "60000" });
    try {
      const show = await c.createShow(["A1", "A2"]);
      const tok = await c.token("alice");
      expect(await c.show(show.id)).toMatchObject({ available: 2, confirmed: 0 });
      const spy = vi.spyOn(c.ctx.pool, "query");
      await Promise.all([c.show(show.id), c.show(show.id), c.show(show.id)]);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      const r = await c.reserve(tok, show.id, ["A1"], "cache-1");
      expect(r.status).toBe(201);
      expect(await c.show(show.id)).toMatchObject({ available: 1, confirmed: 1 });
      expect((await c.cancel(tok, r.body.reservation_id)).status).toBe(200);
      expect(await c.show(show.id)).toMatchObject({ available: 2, confirmed: 0 });
    } finally {
      await c.close();
    }
  });
});
