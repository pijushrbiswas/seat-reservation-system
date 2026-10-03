import { Writable } from "node:stream";
import { defaultFetch, isRetryableStatus, postCompressedJson, rateLimitedReporter, type FetchLike } from "./http.js";

/** Settings for {@link NewRelicLogShipper}. */
export interface NewRelicShipperOptions {
  /** New Relic ingest license key, sent as the `Api-Key` header. */
  licenseKey: string;
  /** Log API URL for the account's region (US, EU, ...). */
  endpoint: string;
  /** Value of the `service` attribute added to every log line. */
  serviceName: string;
  /** How often queued lines are sent, in milliseconds. Default 2000. */
  flushIntervalMs?: number;
  /** Most lines sent in one request. Default 1000. */
  maxBatchLines?: number;
  /** Most lines kept waiting; past this the oldest are dropped. Default 50000. */
  maxQueueLines?: number;
  /** Approximate size cap of one request before compression, under New Relic's 1 MB limit. Default 800000 bytes. */
  maxBatchBytes?: number;
  /** HTTP client; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

/**
 * Sends structured log lines to New Relic's Log API in the background, without ever affecting a request.
 *
 * Lines are queued in memory and sent in gzip-compressed batches on a timer. A failing or slow New Relic only
 * grows the queue, which is capped: when it is full the oldest lines are dropped. Temporary failures (network
 * errors, 429, 5xx) are retried with backoff; permanent ones (a wrong license key, 4xx) drop the batch and are reported.
 * @param options - Endpoint, key, batching and queue limits.
 * @param report - Where internal problems are reported.
 */
export class NewRelicLogShipper {
  private queue: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private sending: Promise<void> | undefined;
  private failures = 0;
  private retryAt = 0;
  private dropped = 0;
  private readonly flushIntervalMs: number;
  private readonly maxBatchLines: number;
  private readonly maxQueueLines: number;
  private readonly maxBatchBytes: number;
  private readonly fetchImpl: FetchLike;

  /** A stream to hand to the logger; every line written to it is queued for New Relic. */
  readonly stream: Writable;

  constructor(
    private readonly options: NewRelicShipperOptions,
    private readonly report: (message: string) => void = rateLimitedReporter("newrelic-logs"),
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? 2_000;
    this.maxBatchLines = options.maxBatchLines ?? 1_000;
    this.maxQueueLines = options.maxQueueLines ?? 50_000;
    this.maxBatchBytes = options.maxBatchBytes ?? 800_000;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
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
    if (this.queue.length > this.maxQueueLines) {
      this.queue.shift();
      this.dropped++;
    }
    if (this.queue.length >= this.maxBatchLines) void this.tick();
  }

  /** Number of lines waiting to be sent. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Sends queued lines now, waiting for any batch already in flight, until the queue is empty or a batch cannot be delivered.
   * Ignores the retry backoff, so it is what shutdown and tests use.
   */
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

  /** Timer and threshold entry point: sends a batch, and more while a full batch is still waiting, respecting the backoff. */
  private async tick(): Promise<void> {
    if (this.sending || this.queue.length === 0 || Date.now() < this.retryAt) return;
    do {
      const failuresBefore = this.failures;
      await this.sendOneBatch();
      if (this.failures > failuresBefore) return;
    } while (this.queue.length >= this.maxBatchLines && Date.now() >= this.retryAt);
  }

  /** Takes up to one batch off the queue and sends it; only one request is in flight at a time. */
  private sendOneBatch(): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = this.deliver().finally(() => {
      this.sending = undefined;
    });
    return this.sending;
  }

  /** Builds, compresses and posts one batch, then decides whether to retry it. */
  private async deliver(): Promise<void> {
    const batch = this.takeBatch();
    if (batch.length === 0) return;
    try {
      const status = await postCompressedJson(this.fetchImpl, this.options.endpoint, this.options.licenseKey, this.buildPayload(batch));
      if (status >= 200 && status < 300) {
        this.failures = 0;
        this.retryAt = 0;
        this.reportDropped();
        return;
      }
      if (isRetryableStatus(status)) {
        this.retryLater(batch, `New Relic answered ${status}`);
        return;
      }
      this.report(`New Relic rejected ${batch.length} log lines with status ${status}; check the license key and endpoint. They were dropped.`);
    } catch (err) {
      this.retryLater(batch, `could not reach New Relic (${(err as Error).message})`);
    }
  }

  /** Removes lines from the front of the queue, up to the line and byte limits. */
  private takeBatch(): string[] {
    let bytes = 0;
    let count = 0;
    while (count < this.queue.length && count < this.maxBatchLines) {
      bytes += Buffer.byteLength(this.queue[count]!);
      if (bytes > this.maxBatchBytes && count > 0) break;
      count++;
    }
    return this.queue.splice(0, count);
  }

  /** Puts a failed batch back at the front of the queue and backs off before the timer tries again. */
  private retryLater(batch: string[], reason: string): void {
    this.queue.unshift(...batch);
    const overflow = this.queue.length - this.maxQueueLines;
    if (overflow > 0) {
      this.queue.splice(0, overflow);
      this.dropped += overflow;
    }
    this.failures++;
    this.retryAt = Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(this.failures, 5));
    this.report(`${reason}; ${this.queue.length} lines waiting, will retry`);
  }

  /**
   * Converts logger JSON lines to the Log API shape: shared attributes once in `common`, then one entry per line.
   * @param lines - Raw JSON lines from the logger.
   */
  private buildPayload(lines: string[]) {
    return [
      {
        common: { attributes: { service: this.options.serviceName } },
        logs: lines.map((line) => {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line) as Record<string, unknown>;
          } catch {
            return { timestamp: Date.now(), message: line };
          }
          // `service` is sent once in `common` (from NEW_RELIC_APP_NAME); a per-line copy would override it.
          const { time, msg, service: _service, ...attributes } = parsed;
          const timestamp = typeof time === "string" ? Date.parse(time) : NaN;
          return {
            timestamp: Number.isNaN(timestamp) ? Date.now() : timestamp,
            message: typeof msg === "string" ? msg : "",
            attributes,
          };
        }),
      },
    ];
  }

  /** After a successful send, says how many lines were lost to a full queue, if any. */
  private reportDropped(): void {
    if (this.dropped === 0) return;
    this.report(`${this.dropped} log lines were dropped because the queue was full`);
    this.dropped = 0;
  }
}
