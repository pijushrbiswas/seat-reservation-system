import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertReconciled, makeApp, seatNames, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => {
  await t.close();
});

describe("cancel", () => {
  it("frees the seats and makes them re-bookable by someone else", async () => {
    const show = await t.createShow(["A1", "A2"]);
    const [a, b] = [await t.token("owner"), await t.token("next")];
    const r = await t.reserve(a, show.id, ["A1", "A2"], "k");
    expect(r.status).toBe(201);
    const c = await t.cancel(a, r.body.reservation_id);
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("cancelled");
    expect(await t.show(show.id)).toMatchObject({ available: 2, confirmed: 0 });
    const again = await t.reserve(b, show.id, ["A1"], "k");
    expect(again.status).toBe(201);
    expect(again.body.user_id).toBe("next");
  });

  it("returns the owner's quota: cancelling lets them book again up to the limit", async () => {
    const show = await t.createShow(seatNames("Q", 10), { per_user_limit: 2 });
    const tok = await t.token("quota");
    const r = await t.reserve(tok, show.id, ["Q1", "Q2"], "k1");
    expect((await t.reserve(tok, show.id, ["Q3"], "k2")).body.error.code).toBe("per_user_limit");
    await t.cancel(tok, r.body.reservation_id);
    expect((await t.reserve(tok, show.id, ["Q3", "Q4"], "k3")).status).toBe(201);
    expect((await t.reserve(tok, show.id, ["Q5"], "k4")).body.error.code).toBe("per_user_limit");
  });

  it("only the owner may cancel, and a rejected cancel moves nothing", async () => {
    const show = await t.createShow(["A1"]);
    const [a, b] = [await t.token("owner2"), await t.token("intruder")];
    const r = await t.reserve(a, show.id, ["A1"], "k");
    const bad = await t.cancel(b, r.body.reservation_id);
    expect(bad.status).toBe(403);
    expect((await t.show(show.id)).confirmed).toBe(1);
    const anon = await t.app.inject({ method: "POST", url: `/reservations/${r.body.reservation_id}/cancel` });
    expect(anon.statusCode).toBe(401);
  });

  it("unknown or malformed reservation ids are 404", async () => {
    const tok = await t.token("nobody");
    expect((await t.cancel(tok, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await t.cancel(tok, "nope")).status).toBe(404);
  });

  it("cancel is idempotent and never resurrects a seat confirmed to someone else", async () => {
    const show = await t.createShow(["A1"]);
    const [a, b] = [await t.token("first"), await t.token("second")];
    const r = await t.reserve(a, show.id, ["A1"], "k");
    expect((await t.cancel(a, r.body.reservation_id)).status).toBe(200);
    expect((await t.reserve(b, show.id, ["A1"], "k")).status).toBe(201);
    const second = await t.cancel(a, r.body.reservation_id);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("cancelled");
    const after = await t.show(show.id);
    expect(after.seats).toEqual([{ seat: "A1", status: "confirmed" }]);
  });

  it("50 parallel cancels of one reservation release it exactly once", async () => {
    const show = await t.createShow(seatNames("C", 4));
    const tok = await t.token("dbl");
    const r = await t.reserve(tok, show.id, ["C1", "C2"], "k");
    const res = await Promise.all(Array.from({ length: 50 }, () => t.cancel(tok, r.body.reservation_id)));
    expect(res.every((x) => x.status === 200)).toBe(true);
    const after = await t.show(show.id);
    expect(after).toMatchObject({ available: 4, confirmed: 0 });
    // quota was returned once, not 50 times: the user can still only hold up to the limit
    const more = await Promise.all(seatNames("C", 4).map((s, i) => t.reserve(tok, show.id, [s], `again-${i}`)));
    expect(more.filter((x) => x.status === 201)).toHaveLength(4);
  });

  it("churn: concurrent reserve/cancel on hot seats never double-sells, never 5xx, stays reconciled", async () => {
    const seats = seatNames("H", 6);
    const show = await t.createShow(seats, { per_user_limit: 3 });
    const users = await Promise.all(Array.from({ length: 40 }, (_, i) => t.token(`churn-${i}`)));
    const results = await Promise.all(
      users.map(async (tok, i) => {
        const out: number[] = [];
        for (let round = 0; round < 5; round++) {
          const picks = [seats[(i + round) % 6]!, seats[(i + round + 1) % 6]!];
          const r = await t.reserve(tok, show.id, picks, `churn-${i}-${round}`);
          out.push(r.status);
          if (r.status === 201) out.push((await t.cancel(tok, r.body.reservation_id)).status);
        }
        return out;
      }),
    );
    const all = results.flat();
    expect(all.filter((s) => s >= 500)).toHaveLength(0);
    const after = await t.show(show.id);
    assertReconciled(after);
    // everyone who booked cancelled right away, so nothing may remain confirmed or held
    expect(after).toMatchObject({ available: 6, confirmed: 0, held: 0 });
    const holdings = await t.ctx.pool.query(
      `SELECT count(*)::int AS n FROM user_show_holdings WHERE show_id = $1 AND held_count <> 0`,
      [show.id],
    );
    expect(holdings.rows[0].n).toBe(0);
  });
});
