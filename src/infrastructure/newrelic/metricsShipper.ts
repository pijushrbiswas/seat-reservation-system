import os from "node:os";
import { defaultFetch, isRetryableStatus, postCompressedJson, rateLimitedReporter, type FetchLike } from "./http.js";

/** Label values of one series; prom-client types them as optional. */
type Labels = Partial<Record<string, string | number>>;

/**
 * The part of a prom-client registry the shipper reads. prom-client types `type` as an enum but returns the strings
 * `counter`, `gauge`, `histogram` and `summary` at runtime, so it is read as a string.
 */
export interface MetricSource {
  getMetricsAsJSON(): Promise<
    Array<{
      name: string;
      type: unknown;
      values: Array<{ value: number; labels: Labels; metricName?: string }>;
    }>
  >;
}

/** Settings for {@link NewRelicMetricsShipper}. */
export interface NewRelicMetricsOptions {
  /** Where the metrics are read from (the Prometheus registry). */
  source: MetricSource;
  /** New Relic ingest license key, sent as the `Api-Key` header. */
  licenseKey: string;
  /** Metric API URL for the account's region. */
  endpoint: string;
  /** Value of the `service` attribute added to every metric. */
  serviceName: string;
  /** How often metrics are sent, in milliseconds. Default 15000. */
  intervalMs?: number;
  /** HTTP client; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Clock in milliseconds; tests replace it. */
  now?: () => number;
  /** Value of the `instance` attribute, so several instances can be told apart. Defaults to the host name. */
  instance?: string;
  /** Most points in one request, to stay under New Relic's 1 MB payload limit. Default 2000. */
  maxPointsPerRequest?: number;
}

/** One data point in New Relic's Metric API format. */
interface Point {
  name: string;
  type: "count" | "gauge";
  value: number;
  timestamp: number;
  "interval.ms"?: number;
  attributes?: Record<string, string | number>;
}

/**
 * Keeps only the labels that have a value, as the Metric API wants plain strings and numbers.
 * @param labels - Labels of one series.
 */
const definedLabels = (labels: Labels): Record<string, string | number> =>
  Object.fromEntries(Object.entries(labels).filter((e): e is [string, string | number] => e[1] !== undefined));

/**
 * Sends the Prometheus metrics to New Relic's Metric API on a timer, in the background.
 *
 * The same metrics `/metrics` serves are converted: counters become `count` metrics carrying the increase since the last
 * successful send (New Relic wants deltas, Prometheus keeps running totals), gauges become `gauge` metrics, and histograms
 * are sent as their `_sum` and `_count` (bucket series are skipped). Metric names and labels are unchanged, so a Prometheus
 * name such as `reservations_confirmed_total` can be queried as it is: `FROM Metric SELECT sum(reservations_confirmed_total)`.
 *
 * A failed send never loses increments: the previous totals are only advanced after a send succeeds (or is rejected for
 * good), so the next send carries everything since then. A problem in New Relic never affects a request.
 * @param options - Source, endpoint, key and interval.
 * @param report - Where internal problems are reported.
 */
export class NewRelicMetricsShipper {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private previous = new Map<string, number>();
  private windowStart: number;
  private readonly intervalMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly instance: string;
  private readonly maxPointsPerRequest: number;

  constructor(
    private readonly options: NewRelicMetricsOptions,
    private readonly report: (message: string) => void = rateLimitedReporter("newrelic-metrics"),
  ) {
    this.intervalMs = options.intervalMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.now = options.now ?? Date.now;
    this.instance = options.instance ?? os.hostname();
    this.maxPointsPerRequest = options.maxPointsPerRequest ?? 2_000;
    this.windowStart = this.now();
  }

  /** Starts sending every interval. Safe to call once; the timer does not keep the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sendNow(), this.intervalMs);
    this.timer.unref();
  }

  /**
   * Collects the current metrics and sends them, unless a send is already running.
   * Never throws.
   */
  sendNow(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.collectAndSend()
      .catch((err) => {
        this.report(`could not send metrics (${(err as Error).message})`);
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  /**
   * Stops the timer and sends one last time so the final increments are not lost on shutdown.
   * @param timeoutMs - Longest time to spend before giving up.
   */
  async close(timeoutMs = 5_000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.race([this.sendNow(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  /** Reads the registry, builds the points, posts them, and advances the baseline when the send is settled. */
  private async collectAndSend(): Promise<void> {
    const sentAt = this.now();
    const intervalMs = Math.max(1, sentAt - this.windowStart);
    const { points, totals } = this.buildPoints(await this.options.source.getMetricsAsJSON(), sentAt, intervalMs);
    if (points.length === 0) return;

    // Counts must be delivered together, because their baseline only moves after they are accepted. Gauges are plain values that
    // the next send replaces, so when there are too many for one request the extra ones go in follow-up requests, best effort.
    const counts = points.filter((p) => p.type === "count");
    const gauges = points.filter((p) => p.type === "gauge");
    const room = Math.max(0, this.maxPointsPerRequest - counts.length);
    const status = await this.post([...counts, ...gauges.slice(0, room)]).catch((err: Error) => {
      this.report(`could not reach New Relic (${err.message}); will retry with the increase since the last send`);
      return undefined;
    });
    if (status === undefined) return;
    if (status >= 200 && status < 300) {
      this.previous = totals;
      this.windowStart = sentAt;
      await this.sendRemainingGauges(gauges.slice(room));
      return;
    }
    if (isRetryableStatus(status)) {
      this.report(`New Relic answered ${status}; will retry with the increase since the last send`);
      return;
    }
    this.previous = totals;
    this.windowStart = sentAt;
    this.report(`New Relic rejected the metrics with status ${status}; check the license key and endpoint. This batch was dropped.`);
  }

  /**
   * Posts one request of points with the shared attributes.
   * @param points - Points to send.
   * @returns The HTTP status code.
   */
  private post(points: Point[]): Promise<number> {
    return postCompressedJson(this.fetchImpl, this.options.endpoint, this.options.licenseKey, [
      { common: { attributes: { service: this.options.serviceName, instance: this.instance } }, metrics: points },
    ]);
  }

  /**
   * Sends gauges that did not fit in the first request, in batches. A failed batch is reported and skipped: the next interval sends fresh values.
   * @param gauges - The leftover gauge points.
   */
  private async sendRemainingGauges(gauges: Point[]): Promise<void> {
    for (let i = 0; i < gauges.length; i += this.maxPointsPerRequest) {
      const status = await this.post(gauges.slice(i, i + this.maxPointsPerRequest)).catch(() => 0);
      if (status < 200 || status >= 300) {
        this.report(`New Relic did not accept a batch of gauges (status ${status || "network error"}); fresh values follow next interval`);
        return;
      }
    }
  }

  /**
   * Converts Prometheus metrics to Metric API points.
   * @param metrics - Output of the registry's `getMetricsAsJSON()`.
   * @param sentAt - Timestamp of this send.
   * @param intervalMs - Length of the window counters cover.
   * @returns The points, and the new running totals to remember after a successful send.
   */
  private buildPoints(metrics: Awaited<ReturnType<MetricSource["getMetricsAsJSON"]>>, sentAt: number, intervalMs: number) {
    const points: Point[] = [];
    const totals = new Map<string, number>();
    const asCount = (name: string, labels: Labels, value: number) => {
      const key = `${name}|${JSON.stringify(Object.entries(labels).sort())}`;
      totals.set(key, value);
      const before = this.previous.get(key) ?? 0;
      // A total that went down means the process restarted and the counter started again from zero.
      const delta = value >= before ? value - before : value;
      points.push({ name, type: "count", value: delta, timestamp: this.windowStart, "interval.ms": intervalMs, attributes: definedLabels(labels) });
    };

    for (const metric of metrics) {
      const kind = String(metric.type);
      for (const v of metric.values) {
        if (!Number.isFinite(v.value)) continue;
        if (kind === "counter") asCount(metric.name, v.labels, v.value);
        else if (kind === "gauge") points.push({ name: metric.name, type: "gauge", value: v.value, timestamp: sentAt, attributes: definedLabels(v.labels) });
        else if (kind === "histogram" && (v.metricName?.endsWith("_sum") || v.metricName?.endsWith("_count"))) {
          asCount(v.metricName, v.labels, v.value);
        }
      }
    }
    return { points, totals };
  }
}
