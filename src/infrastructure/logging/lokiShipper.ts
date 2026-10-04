import { Writable } from "node:stream";

/** The part of `fetch` the shipper needs; tests pass a fake. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number }>;

/** Settings for {@link LokiLogShipper}. */
export interface LokiShipperOptions {
  /** Loki push URL, for example `https://monitoring.onrender.com/loki/api/v1/push`. */
  url: string;
  /** Sent as `Authorization: Bearer <token>` when set. */
  token?: string;
  /** Value of the `service` label on every stream. */
  serviceName: string;
  /** How often queued lines are sent, in milliseconds. Default 2000. */
  flushIntervalMs?: number;
  /** Most lines sent in one request. Default 500. */
  maxBatchLines?: number;
  /** Most lines kept waiting; past this the oldest are dropped. Default 20000. */
  maxQueueLines?: number;
  /** How long one request may take before it is abandoned and retried, in milliseconds. Default 90000, because a sleeping free Render service needs about a minute to wake. */
  requestTimeoutMs?: number;
  /** HTTP client; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

/**
 * Pushes structured log lines to Loki in the background, without ever affecting a request.
 *
 * Lines are queued in memory and sent in batches on a timer, grouped into one Loki stream per log level. A slow or unreachable Loki only
 * grows the queue, which is capped: when it is full the oldest lines are dropped. Network errors, 429 and 5xx are retried with backoff;
 * other 4xx answers (a wrong token) drop the batch and are reported on stderr, not through the logger, so a failure cannot feed itself.
 * @param options - Endpoint, token, batching and queue limits.
 * @param report - Where internal problems are reported; by default stderr, at most once a minute.
 */
export class LokiLogShipper {
  private queue: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private sending: Promise<void> | undefined;
  private failures = 0;
  private retryAt = 0;
  private lastReportAt = 0;
  private readonly flushIntervalMs: number;
  private readonly maxBatchLines: number;
  private readonly maxQueueLines: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: FetchLike;

  /** A stream to hand to the logger; every line written to it is queued for Loki. */
  readonly stream: Writable;

  constructor(
    private readonly options: LokiShipperOptions,
    private readonly report: (message: string) => void = (message) => {
      const now = Date.now();
      if (now - this.lastReportAt < 60_000) return;
      this.lastReportAt = now;
      process.stderr.write(`loki: ${message}\n`);
    },
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? 2_000;
    this.maxBatchLines = options.maxBatchLines ?? 500;
    this.maxQueueLines = options.maxQueueLines ?? 20_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 90_000;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.stream = new Writable({
      write: (chunk, _encoding, callback) => {
        this.enqueue(chunk.toString());
        callback();
      },
    });
    this.timer = setInterval(() => void this.tick(), this.flushIntervalMs);
    this.timer.unref();
  }

  /**
   * Queues one log line. When the queue is full the oldest line is dropped, so memory stays bounded.
   * @param line - One JSON log line as written by the logger.
   */
  enqueue(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.queue.push(trimmed);
    if (this.queue.length > this.maxQueueLines) this.queue.shift();
    if (this.queue.length >= this.maxBatchLines) void this.tick();
  }

  /** Number of lines waiting to be sent. */
  get pending(): number {
    return this.queue.length;
  }

  /** Sends queued lines now, ignoring the retry backoff, until the queue is empty or a batch cannot be delivered. */
  async flush(): Promise<void> {
    for (;;) {
      if (this.sending) {
        await this.sending;
        continue;
      }
      if (this.queue.length === 0) return;
      const failuresBefore = this.failures;
      await this.sendOneBatch();
      if (this.failures > failuresBefore) return;
    }
  }

  /**
   * Stops the timer and sends what is left, waiting at most `timeoutMs`.
   * @param timeoutMs - Longest time to spend delivering before giving up.
   */
  async close(timeoutMs = 5_000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.race([this.flush(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  private async tick(): Promise<void> {
    if (this.sending || this.queue.length === 0 || Date.now() < this.retryAt) return;
    do {
      const failuresBefore = this.failures;
      await this.sendOneBatch();
      if (this.failures > failuresBefore) return;
    } while (this.queue.length >= this.maxBatchLines && Date.now() >= this.retryAt);
  }

  private sendOneBatch(): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = this.deliver().finally(() => {
      this.sending = undefined;
    });
    return this.sending;
  }

  private async deliver(): Promise<void> {
    const batch = this.queue.splice(0, this.maxBatchLines);
    if (batch.length === 0) return;
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
      const { status } = await this.fetchImpl(this.options.url, {
        method: "POST",
        headers,
        body: JSON.stringify(this.buildPayload(batch)),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (status >= 200 && status < 300) {
        this.failures = 0;
        this.retryAt = 0;
        return;
      }
      if (status === 429 || status >= 500) {
        this.retryLater(batch, `Loki answered ${status}`);
        return;
      }
      this.report(`Loki rejected ${batch.length} log lines with status ${status}; check LOKI_URL and LOKI_TOKEN. They were dropped.`);
    } catch (err) {
      this.retryLater(batch, `could not reach Loki (${(err as Error).message})`);
    }
  }

  /** Puts a failed batch back at the front of the queue and backs off before the timer tries again. */
  private retryLater(batch: string[], reason: string): void {
    this.queue.unshift(...batch);
    const overflow = this.queue.length - this.maxQueueLines;
    if (overflow > 0) this.queue.splice(0, overflow);
    this.failures++;
    this.retryAt = Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(this.failures, 5));
    this.report(`${reason}; ${this.queue.length} lines waiting, will retry`);
  }

  /**
   * Converts logger JSON lines to Loki's push format: one stream per level, each value `[timestamp in nanoseconds, line]`.
   * @param lines - Raw JSON lines from the logger.
   */
  private buildPayload(lines: string[]) {
    const streams = new Map<string, [string, string][]>();
    for (const line of lines) {
      let level = "info";
      let ms = Date.now();
      try {
        const parsed = JSON.parse(line) as { level?: unknown; time?: unknown };
        if (typeof parsed.level === "string") level = parsed.level;
        const t = typeof parsed.time === "string" ? Date.parse(parsed.time) : NaN;
        if (!Number.isNaN(t)) ms = t;
      } catch {
        // not JSON: keep the line with the current time and the default level
      }
      const values = streams.get(level) ?? [];
      values.push([`${ms}000000`, line]);
      streams.set(level, values);
    }
    return {
      streams: [...streams].map(([level, values]) => ({ stream: { service: this.options.serviceName, level }, values })),
    };
  }
}
