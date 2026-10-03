import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

/** Minimal HTTP client the New Relic shippers need; the default wraps the global `fetch`, tests pass a fake. */
export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: Buffer },
) => Promise<{ status: number }>;

/** The default {@link FetchLike}: the global `fetch`. */
export const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: new Uint8Array(init.body) });
  return { status: res.status };
};

/**
 * Posts a JSON payload to a New Relic ingest API, gzip-compressed and authenticated with the license key.
 * @param fetchImpl - HTTP client.
 * @param url - Ingest endpoint.
 * @param licenseKey - New Relic ingest license key.
 * @param payload - Value to send as JSON.
 * @returns The HTTP status code.
 */
export async function postCompressedJson(fetchImpl: FetchLike, url: string, licenseKey: string, payload: unknown): Promise<number> {
  const body = await gzipAsync(Buffer.from(JSON.stringify(payload)));
  const { status } = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip", "api-key": licenseKey },
    body,
  });
  return status;
}

/**
 * Tells whether a failed response is worth retrying: rate limiting and server errors are, bad requests and bad keys are not.
 * @param status - HTTP status code.
 */
export const isRetryableStatus = (status: number) => status === 429 || status >= 500;

/**
 * Builds a reporter that prints a problem to stderr at most once a minute, so an outage cannot flood it.
 * It deliberately does not use the application logger, which may itself be feeding the shipper.
 * @param prefix - Text put in front of every message.
 */
export function rateLimitedReporter(prefix: string): (message: string) => void {
  let last = 0;
  return (message) => {
    const now = Date.now();
    if (now - last < 60_000) return;
    last = now;
    console.error(`[${prefix}] ${message}`);
  };
}
