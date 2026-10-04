import { describe, expect, it } from "vitest";
import { LokiLogShipper, type FetchLike } from "../src/infrastructure/logging/lokiShipper.js";
import { LogRing, createLogger } from "../src/infrastructure/logging/logger.js";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { streams: { stream: Record<string, string>; values: [string, string][] }[] };
}

/** A fake Loki that records every push and answers with the next status in the list (then 204). */
function fakeLoki(statuses: number[] = []) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { status: statuses.shift() ?? 204 };
  };
  return { calls, fetchImpl };
}

const line = (level: string, msg: string, time = "2026-10-04T08:00:00.000Z") => JSON.stringify({ level, time, service: "seat-reservation", msg });

describe("LokiLogShipper", () => {
  it("pushes one stream per level with nanosecond timestamps and the bearer token", async () => {
    const loki = fakeLoki();
    const s = new LokiLogShipper({ url: "http://loki/push", token: "t0k", serviceName: "seat-reservation", fetchImpl: loki.fetchImpl, flushIntervalMs: 60_000 }, () => {});
    s.enqueue(line("info", "a"));
    s.enqueue(line("error", "b"));
    s.enqueue(line("info", "c"));
    await s.flush();
    await s.close();
    expect(loki.calls).toHaveLength(1);
    expect(loki.calls[0]!.url).toBe("http://loki/push");
    expect(loki.calls[0]!.headers.authorization).toBe("Bearer t0k");
    const streams = loki.calls[0]!.body.streams;
    expect(streams.map((x) => x.stream).sort((a, b) => a.level!.localeCompare(b.level!))).toEqual([
      { service: "seat-reservation", level: "error" },
      { service: "seat-reservation", level: "info" },
    ]);
    const info = streams.find((x) => x.stream.level === "info")!;
    expect(info.values).toHaveLength(2);
    expect(info.values[0]![0]).toBe(`${Date.parse("2026-10-04T08:00:00.000Z")}000000`);
  });

  it("keeps lines when Loki is down or asleep and delivers them once it answers", async () => {
    const loki = fakeLoki([503, 502]);
    const s = new LokiLogShipper({ url: "http://loki/push", serviceName: "x", fetchImpl: loki.fetchImpl, flushIntervalMs: 60_000 }, () => {});
    s.enqueue(line("info", "a"));
    await s.flush();
    expect(s.pending).toBe(1);
    await s.flush();
    expect(s.pending).toBe(1);
    await s.flush();
    expect(s.pending).toBe(0);
    expect(loki.calls).toHaveLength(3);
    await s.close();
  });

  it("drops a batch the server rejects for good, and reports it", async () => {
    const loki = fakeLoki([401]);
    const reports: string[] = [];
    const s = new LokiLogShipper({ url: "http://loki/push", serviceName: "x", fetchImpl: loki.fetchImpl }, (m) => reports.push(m));
    s.enqueue(line("info", "a"));
    await s.flush();
    expect(s.pending).toBe(0);
    expect(reports.join(" ")).toContain("401");
    await s.close();
  });

  it("caps the queue and drops the oldest lines", async () => {
    const loki = fakeLoki();
    const s = new LokiLogShipper({ url: "http://loki/push", serviceName: "x", fetchImpl: loki.fetchImpl, maxQueueLines: 3, maxBatchLines: 100, flushIntervalMs: 60_000 }, () => {});
    for (let i = 0; i < 10; i++) s.enqueue(line("info", `m${i}`));
    expect(s.pending).toBe(3);
    await s.flush();
    const sent = loki.calls[0]!.body.streams[0]!.values.map((v) => JSON.parse(v[1]).msg);
    expect(sent).toEqual(["m7", "m8", "m9"]);
    await s.close();
  });

  it("receives every line the logger writes", async () => {
    const loki = fakeLoki();
    const s = new LokiLogShipper({ url: "http://loki/push", serviceName: "x", fetchImpl: loki.fetchImpl, flushIntervalMs: 60_000 }, () => {});
    const sink = new (await import("node:stream")).Writable({ write: (_c, _e, cb) => cb() });
    const log = createLogger("info", new LogRing(10), sink, [s.stream]);
    log.info({ route: "/x" }, "hello");
    log.error("boom");
    await s.flush();
    const levels = loki.calls[0]!.body.streams.map((x) => x.stream.level).sort();
    expect(levels).toEqual(["error", "info"]);
    await s.close();
  });
});
