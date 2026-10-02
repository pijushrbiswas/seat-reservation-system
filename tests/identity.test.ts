import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => {
  await t.close();
});

describe("identity is token-derived", () => {
  it("a spoofed user_id in the body is ignored", async () => {
    const show = await t.createShow(["A1", "A2"]);
    const tok = await t.token("real-user");
    const r = await t.reserve(tok, show.id, ["A1"], "k", { user_id: "victim", userId: "victim" });
    expect(r.status).toBe(201);
    expect(r.body.user_id).toBe("real-user");
  });

  it("a spoofed identity cannot cancel someone else's reservation", async () => {
    const show = await t.createShow(["A1"]);
    const [owner, attacker] = [await t.token("owner"), await t.token("attacker")];
    const r = await t.reserve(owner, show.id, ["A1"], "k");
    const res = await t.app.inject({
      method: "POST",
      url: `/reservations/${r.body.reservation_id}/cancel`,
      headers: { authorization: `Bearer ${attacker}`, "x-user-id": "owner" },
      payload: { user_id: "owner" },
    });
    expect(res.statusCode).toBe(403);
    expect((await t.show(show.id)).confirmed).toBe(1);
  });

  it("a token signed with another secret is rejected", async () => {
    const other = await makeApp({ JWT_SECRET: "a-different-secret" });
    const forged = await other.token("owner");
    await other.close();
    const show = await t.createShow(["A1"]);
    expect((await t.reserve(forged, show.id, ["A1"], "k")).status).toBe(401);
  });
});
