import { gunzipSync } from "node:zlib";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import type { FetchLike } from "../src/infrastructure/newrelic/http.js";
import { NewRelicMetricsShipper } from "../src/infrastructure/newrelic/metricsShipper.js";

type Point = { name: string; type: string; value: number; timestamp: number; "interval.ms"?: number; attributes?: Record<string, unknown> };

function fakeFetch(statuses: Array<number | Error> = []) {
  const sent: Array<{ url: string; headers: Record<string, string>; body: Array<{ common: { attributes: Record<string, unknown> }; metrics: Point[] }> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const outcome = statuses.length ? statuses.shift()! : 202;
    if (outcome instanceof Error) throw outcome;
    if (outcome < 300) sent.push({ url, headers: init.headers, body: JSON.parse(gunzipSync(init.body).toString()) });
    return { status: outcome };
  };
  return { sent, fetchImpl };
}

function setup(statuses: Array<number | Error> = []) {
  const registry = new Registry();
  const confirmed = new Counter({ name: "reservations_confirmed_total", help: "h", registers: [registry] });
  const declined = new Counter({ name: "reservations_declined_total", help: "h", labelNames: ["reason"], registers: [registry] });
  const available = new Gauge({ name: "seats_available", help: "h", labelNames: ["show_id"], registers: [registry] });
  const latency = new Histogram({ name: "http_request_duration_seconds", help: "h", labelNames: ["route"], buckets: [0.1, 1], registers: [registry] });
  let clock = 1_000_000;
  const { sent, fetchImpl } = fakeFetch(statuses);
  const reports: string[] = [];
  const shipper = new NewRelicMetricsShipper(
    { source: registry, licenseKey: "secret-key", endpoint: "https://nr.test/metric/v1", serviceName: "seat-reservation", instance: "pod-1", intervalMs: 3_600_000, fetchImpl, now: () => clock },
    (m) => reports.push(m),
  );
  return { registry, confirmed, declined, available, latency, shipper, sent, reports, advance: (ms: number) => (clock += ms), clock: () => clock };
}

const byName = (points: Point[], name: string) => points.filter((p) => p.name === name);

describe("New Relic metrics shipper", () => {
  it("converts counters to counts, gauges to gauges, and histograms to sum and count, with labels and shared attributes", async () => {
    const t = setup();
    t.confirmed.inc(3);
    t.declined.inc({ reason: "seat_taken" }, 7);
    t.available.set({ show_id: "s1" }, 42);
    t.latency.observe({ route: "/reserve" }, 0.5);
    t.advance(15_000);
    await t.shipper.sendNow();

    expect(t.sent).toHaveLength(1);
    const req = t.sent[0]!;
    expect(req.url).toBe("https://nr.test/metric/v1");
    expect(req.headers).toMatchObject({ "api-key": "secret-key", "content-encoding": "gzip" });
    expect(req.body[0]!.common.attributes).toEqual({ service: "seat-reservation", instance: "pod-1" });
    const points = req.body[0]!.metrics;

    expect(byName(points, "reservations_confirmed_total")[0]).toMatchObject({ type: "count", value: 3, "interval.ms": 15_000, timestamp: 1_000_000 });
    expect(byName(points, "reservations_declined_total")[0]).toMatchObject({ type: "count", value: 7, attributes: { reason: "seat_taken" } });
    expect(byName(points, "seats_available")[0]).toMatchObject({ type: "gauge", value: 42, attributes: { show_id: "s1" }, timestamp: 1_015_000 });
    expect(byName(points, "http_request_duration_seconds_count")[0]).toMatchObject({ type: "count", value: 1, attributes: { route: "/reserve" } });
    expect(byName(points, "http_request_duration_seconds_sum")[0]).toMatchObject({ type: "count", value: 0.5 });
    expect(byName(points, "http_request_duration_seconds_bucket")).toHaveLength(0);
  });

  it("sends only the increase since the last successful send", async () => {
    const t = setup();
    t.confirmed.inc(3);
    t.advance(15_000);
    await t.shipper.sendNow();
    t.confirmed.inc(2);
    t.advance(15_000);
    await t.shipper.sendNow();
    expect(byName(t.sent[1]!.body[0]!.metrics, "reservations_confirmed_total")[0]).toMatchObject({ value: 2, timestamp: 1_015_000, "interval.ms": 15_000 });
  });

  it("loses no increments when New Relic is down: the next send carries everything since the last success", async () => {
    const t = setup([503, new Error("ECONNRESET")]);
    t.confirmed.inc(3);
    t.advance(15_000);
    await t.shipper.sendNow();
    t.confirmed.inc(4);
    t.advance(15_000);
    await t.shipper.sendNow();
    t.confirmed.inc(1);
    t.advance(15_000);
    await t.shipper.sendNow();
    expect(t.sent).toHaveLength(1);
    expect(byName(t.sent[0]!.body[0]!.metrics, "reservations_confirmed_total")[0]).toMatchObject({ value: 8, timestamp: 1_000_000, "interval.ms": 45_000 });
    expect(t.reports.length).toBe(2);
  });

  it("treats a total that went down as a restarted counter and sends the new total", async () => {
    const t = setup();
    t.confirmed.inc(10);
    t.advance(1_000);
    await t.shipper.sendNow();
    t.confirmed.reset();
    t.confirmed.inc(2);
    t.advance(1_000);
    await t.shipper.sendNow();
    expect(byName(t.sent[1]!.body[0]!.metrics, "reservations_confirmed_total")[0]!.value).toBe(2);
  });

  it("drops a batch New Relic rejects for good and reports it without the key", async () => {
    const t = setup([403]);
    t.confirmed.inc(1);
    t.advance(1_000);
    await t.shipper.sendNow();
    t.confirmed.inc(1);
    t.advance(1_000);
    await t.shipper.sendNow();
    expect(t.reports[0]).toContain("403");
    expect(t.reports[0]).not.toContain("secret-key");
    expect(byName(t.sent[0]!.body[0]!.metrics, "reservations_confirmed_total")[0]!.value).toBe(1);
  });

  it("never throws when the source itself fails", async () => {
    const reports: string[] = [];
    const shipper = new NewRelicMetricsShipper(
      { source: { getMetricsAsJSON: async () => { throw new Error("boom"); } }, licenseKey: "k", endpoint: "https://nr.test", serviceName: "s", fetchImpl: fakeFetch().fetchImpl },
      (m) => reports.push(m),
    );
    await expect(shipper.sendNow()).resolves.toBeUndefined();
    expect(reports[0]).toContain("boom");
  });

  it("sends a final batch on close so shutdown does not lose the last increments", async () => {
    const t = setup();
    t.shipper.start();
    t.confirmed.inc(5);
    t.advance(2_000);
    await t.shipper.close();
    expect(byName(t.sent[0]!.body[0]!.metrics, "reservations_confirmed_total")[0]!.value).toBe(5);
  });
});

describe("New Relic metrics with many shows", () => {
  it("splits a large set of gauges over several requests, keeps every count in the first, and delivers every gauge once", async () => {
    const registry = new Registry();
    const confirmed = new Counter({ name: "reservations_confirmed_total", help: "h", registers: [registry] });
    const seats = new Gauge({ name: "seats_available", help: "h", labelNames: ["show_id"], registers: [registry] });
    for (let i = 0; i < 25; i++) seats.set({ show_id: `show-${i}` }, i);
    confirmed.inc(4);
    const { sent, fetchImpl } = fakeFetch();
    const shipper = new NewRelicMetricsShipper(
      { source: registry, licenseKey: "k", endpoint: "https://nr.test", serviceName: "s", fetchImpl, maxPointsPerRequest: 10, instance: "i" },
      () => {},
    );
    await shipper.sendNow();
    expect(sent.length).toBe(3);
    expect(sent.every((r) => r.body[0]!.metrics.length <= 10)).toBe(true);
    const all = sent.flatMap((r) => r.body[0]!.metrics);
    expect(all.filter((p) => p.name === "reservations_confirmed_total")).toHaveLength(1);
    expect(sent[0]!.body[0]!.metrics.some((p) => p.name === "reservations_confirmed_total")).toBe(true);
    expect(new Set(all.filter((p) => p.name === "seats_available").map((p) => p.attributes!.show_id)).size).toBe(25);
  });
});

describe("New Relic metrics config", () => {
  const base = { DATABASE_URL: "postgres://x", JWT_SECRET: "j", ADMIN_TOKEN: "a" };
  it("defaults to the US endpoint, every 15 seconds, enabled", () => {
    const c = loadConfig(base);
    expect(c.newRelicMetricsEndpoint).toBe("https://metric-api.newrelic.com/metric/v1");
    expect(c.newRelicMetricsIntervalSeconds).toBe(15);
    expect(c.newRelicMetricsEnabled).toBe(true);
  });
  it("reports every show by default, and METRICS_MAX_SHOWS can cap it", () => {
    expect(loadConfig(base).metricsMaxShows).toBe(0);
    expect(loadConfig({ ...base, METRICS_MAX_SHOWS: "50" }).metricsMaxShows).toBe(50);
  });
  it("supports the EU region, an explicit endpoint, and switching metrics off", () => {
    expect(loadConfig({ ...base, NEW_RELIC_REGION: "eu" }).newRelicMetricsEndpoint).toBe("https://metric-api.eu.newrelic.com/metric/v1");
    expect(loadConfig({ ...base, NEW_RELIC_METRICS_ENDPOINT: "https://x/metric/v1" }).newRelicMetricsEndpoint).toBe("https://x/metric/v1");
    expect(loadConfig({ ...base, NEW_RELIC_METRICS_ENABLED: "false" }).newRelicMetricsEnabled).toBe(false);
  });
});
