import { gunzipSync } from "node:zlib";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { LogRing, createLogger } from "../src/infrastructure/logging/logger.js";
import type { FetchLike } from "../src/infrastructure/newrelic/http.js";
import { NewRelicLogShipper } from "../src/infrastructure/newrelic/logShipper.js";

interface Sent {
  url: string;
  headers: Record<string, string>;
  payload: Array<{ common: { attributes: Record<string, unknown> }; logs: Array<Record<string, any>> }>;
}

/** A fake HTTP client that records what would be sent and answers with the given statuses in turn. */
function fakeFetch(statuses: Array<number | Error> = []) {
  const sent: Sent[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const outcome = statuses.length ? statuses.shift()! : 202;
    if (outcome instanceof Error) throw outcome;
    if (outcome < 300) sent.push({ url, headers: init.headers, payload: JSON.parse(gunzipSync(init.body).toString()) });
    return { status: outcome };
  };
  return { sent, fetchImpl };
}

const shipper = (fetchImpl: FetchLike, extra: Partial<ConstructorParameters<typeof NewRelicLogShipper>[0]> = {}, reports: string[] = []) =>
  new NewRelicLogShipper(
    { licenseKey: "secret-key", endpoint: "https://nr.test/log/v1", serviceName: "seat-reservation", flushIntervalMs: 3_600_000, fetchImpl, ...extra },
    (m) => reports.push(m),
  );

const line = (n: number) => JSON.stringify({ level: "info", time: `2026-10-03T08:00:0${n}.000Z`, service: "seat-reservation", request_id: `r${n}`, msg: `request ${n}` });

describe("New Relic log shipper", () => {
  it("sends a gzip batch with the license key, shared attributes once, and one entry per line", async () => {
    const { sent, fetchImpl } = fakeFetch();
    const s = shipper(fetchImpl);
    s.enqueue(line(1));
    s.enqueue(line(2));
    await s.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://nr.test/log/v1");
    expect(sent[0]!.headers).toMatchObject({ "api-key": "secret-key", "content-encoding": "gzip", "content-type": "application/json" });
    const [block] = sent[0]!.payload;
    expect(block!.common.attributes).toEqual({ service: "seat-reservation" });
    expect(block!.logs).toHaveLength(2);
    expect(block!.logs[0]).toMatchObject({
      timestamp: Date.parse("2026-10-03T08:00:01.000Z"),
      message: "request 1",
      attributes: { level: "info", request_id: "r1" },
    });
    expect(block!.logs[0]!.attributes.time).toBeUndefined();
    expect(block!.logs[0]!.attributes.service).toBeUndefined();
    expect(block!.logs[0]!.attributes.msg).toBeUndefined();
    expect(s.pending).toBe(0);
    await s.close();
  });

  it("splits a large queue into several requests", async () => {
    const { sent, fetchImpl } = fakeFetch();
    const s = shipper(fetchImpl, { maxBatchLines: 2 });
    for (let i = 1; i <= 5; i++) s.enqueue(line(i));
    await s.flush();
    expect(sent.map((x) => x.payload[0]!.logs.length)).toEqual([2, 2, 1]);
    await s.close();
  });

  it("keeps the lines and retries after a 5xx or a network error, without losing or repeating any", async () => {
    const { sent, fetchImpl } = fakeFetch([503, new Error("ECONNRESET")]);
    const reports: string[] = [];
    const s = shipper(fetchImpl, {}, reports);
    s.enqueue(line(1));
    await s.flush();
    expect(s.pending).toBe(1);
    await s.flush();
    expect(s.pending).toBe(1);
    await s.flush();
    expect(s.pending).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload[0]!.logs.map((l) => l.message)).toEqual(["request 1"]);
    expect(reports.length).toBeGreaterThan(0);
    await s.close();
  });

  it("drops a batch New Relic rejects for good (for example a wrong license key) and says so", async () => {
    const { sent, fetchImpl } = fakeFetch([403]);
    const reports: string[] = [];
    const s = shipper(fetchImpl, {}, reports);
    s.enqueue(line(1));
    await s.flush();
    expect(s.pending).toBe(0);
    expect(sent).toHaveLength(0);
    expect(reports[0]).toContain("403");
    expect(reports[0]).not.toContain("secret-key");
    await s.close();
  });

  it("bounds memory: when the queue is full the oldest lines are dropped", async () => {
    const { sent, fetchImpl } = fakeFetch();
    const s = shipper(fetchImpl, { maxQueueLines: 3, maxBatchLines: 100 });
    for (let i = 1; i <= 5; i++) s.enqueue(line(i));
    expect(s.pending).toBe(3);
    await s.flush();
    expect(sent[0]!.payload[0]!.logs.map((l) => l.message)).toEqual(["request 3", "request 4", "request 5"]);
    await s.close();
  });

  it("never throws into the caller when New Relic is unreachable", async () => {
    const { fetchImpl } = fakeFetch([new Error("down"), new Error("down")]);
    const s = shipper(fetchImpl);
    expect(() => s.enqueue(line(1))).not.toThrow();
    await expect(s.flush()).resolves.toBeUndefined();
    await expect(s.close(50)).resolves.toBeUndefined();
  });

  it("receives every log line from the real logger alongside stdout and /logs", async () => {
    const { sent, fetchImpl } = fakeFetch();
    const s = shipper(fetchImpl);
    const stdout: string[] = [];
    const sink = new Writable({ write: (c, _e, cb) => (stdout.push(c.toString()), cb()) });
    const ring = new LogRing(10);
    const log = createLogger("info", ring, sink, [s.stream]);
    log.info({ request_id: "abc", status: 201 }, "request completed");
    await s.flush();
    expect(stdout).toHaveLength(1);
    expect(ring.getRecentLines()).toHaveLength(1);
    expect(sent[0]!.payload[0]!.logs[0]).toMatchObject({ message: "request completed", attributes: { request_id: "abc", status: 201, level: "info" } });
    await s.close();
  });
});

describe("New Relic config", () => {
  const base = { DATABASE_URL: "postgres://x", JWT_SECRET: "j", ADMIN_TOKEN: "a" };
  it("is off without a license key, and picks the US endpoint by default", () => {
    const c = loadConfig(base);
    expect(c.newRelicLicenseKey).toBeUndefined();
    expect(c.newRelicLogEndpoint).toBe("https://log-api.newrelic.com/log/v1");
    expect(c.newRelicAppName).toBe("seat-reservation");
  });
  it("supports the EU region and an explicit endpoint", () => {
    expect(loadConfig({ ...base, NEW_RELIC_LICENSE_KEY: "k", NEW_RELIC_REGION: "EU" }).newRelicLogEndpoint).toBe("https://log-api.eu.newrelic.com/log/v1");
    expect(loadConfig({ ...base, NEW_RELIC_LOG_ENDPOINT: "https://x/log/v1" }).newRelicLogEndpoint).toBe("https://x/log/v1");
  });
});
