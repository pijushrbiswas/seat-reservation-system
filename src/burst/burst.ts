// On-sale stampede against a running instance.
//   npm run burst -- <BASE_URL>            (or: make burst BASE_URL=https://...)
// Env: ADMIN_TOKEN (default dev-admin-token), HOT_USERS=500, USERS=5000, REQUESTS=20000,
//      SEATS=5000, HOT_SEATS=10, CONCURRENCY=1000, SCALE=1 (multiplies USERS/REQUESTS/HOT_USERS/SEATS)
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";

const base = new URL(process.argv[2] ?? process.env.BASE_URL ?? "http://localhost:8080");
const adminToken = process.env.ADMIN_TOKEN ?? "dev-admin-token";
const scale = Number(process.env.SCALE ?? 1);
const num = (name: string, d: number) => Math.max(1, Math.round(Number(process.env[name] ?? d)));
const HOT_USERS = num("HOT_USERS", 500 * scale);
const USERS = num("USERS", 5000 * scale);
const REQUESTS = num("REQUESTS", 20000 * scale);
const SEATS = num("SEATS", 5000 * scale);
const HOT_SEATS = Math.min(num("HOT_SEATS", 10), SEATS);
const CONCURRENCY = num("CONCURRENCY", 1000);
const PRICE = 25000;
const LIMIT = 4;

const agent = new (base.protocol === "https:" ? https : http).Agent({ keepAlive: true, maxSockets: CONCURRENCY });

interface Res {
  status: number;
  body: any;
  ms: number;
  error?: string;
}

function request(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Res> {
  return new Promise((resolve) => {
    const started = performance.now();
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const lib = base.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || undefined,
        path: base.pathname.replace(/\/$/, "") + path,
        method,
        agent,
        timeout: 120_000,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: any = text;
          try {
            body = JSON.parse(text);
          } catch {
            /* plain text (e.g. /metrics) */
          }
          resolve({ status: res.statusCode ?? 0, body, ms: performance.now() - started });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, body: null, ms: performance.now() - started, error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

const failures: string[] = [];
const warnings: string[] = [];
function check(ok: boolean, label: string, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function classify(r: Res): string {
  if (r.status === 0) return `network_error`;
  if (r.status === 201) return "confirmed";
  if (r.status === 200) return "idempotent_replay";
  if (r.status >= 500) return `5xx`;
  if (r.status === 409 || r.status === 422) return r.body?.error?.code ?? `${r.status}`;
  return `other_${r.status}`;
}

function distribution(results: Res[]): Record<string, number> {
  const d: Record<string, number> = {};
  for (const r of results) d[classify(r)] = (d[classify(r)] ?? 0) + 1;
  return d;
}

function printDistribution(title: string, results: Res[], wallMs: number): void {
  const d = distribution(results);
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\n${title}`);
  for (const [k, v] of Object.entries(d).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);
  console.log(
    `  requests=${results.length}  wall=${(wallMs / 1000).toFixed(2)}s  rps=${Math.round(results.length / (wallMs / 1000))}` +
      `  latency p50/p95/p99 = ${percentile(lat, 50).toFixed(0)}/${percentile(lat, 95).toFixed(0)}/${percentile(lat, 99).toFixed(0)} ms`,
  );
}

async function mintTokens(prefix: string, n: number): Promise<string[]> {
  const res = await pool(Array.from({ length: n }, (_, i) => i), 200, (i) =>
    request("POST", "/auth/token", { body: { user_id: `${prefix}-${i}` } }),
  );
  const bad = res.filter((r) => r.status !== 201);
  if (bad.length) throw new Error(`token minting failed ${bad.length}/${n}: ${bad[0]!.status} ${bad[0]!.error ?? JSON.stringify(bad[0]!.body)}`);
  return res.map((r) => r.body.token as string);
}

async function createShow(name: string, seats: string[], limit = LIMIT) {
  const r = await request("POST", "/shows", {
    token: adminToken,
    body: { name, seats, price_paise: PRICE, per_user_limit: limit },
  });
  if (r.status !== 201) throw new Error(`create show failed: ${r.status} ${JSON.stringify(r.body)} ${r.error ?? ""}`);
  return r.body as { id: string; total_seats: number };
}

const getShow = async (id: string, seats = true) => (await request("GET", `/shows/${id}?seats=${seats}`)).body;

async function scrapeMetrics(): Promise<Map<string, number>> {
  const r = await request("GET", "/metrics");
  const m = new Map<string, number>();
  if (r.status !== 200 || typeof r.body !== "string") return m;
  for (const line of r.body.split("\n")) {
    const match = /^([a-z_]+(?:\{[^}]*\})?) (\S+)$/.exec(line);
    if (match) m.set(match[1]!, Number(match[2]));
  }
  return m;
}

const RUN = randomUUID().slice(0, 8);
const seatNames = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);

async function hotSeatStorm(): Promise<void> {
  console.log(`\n=== 1. hot-seat storm: ${HOT_USERS} users, one seat (A12) ===`);
  const show = await createShow(`burst-hot-${RUN}`, seatNames("A", 100));
  const tokens = await mintTokens(`hot-${RUN}`, HOT_USERS);
  const t0 = performance.now();
  const results = await pool(tokens, CONCURRENCY, (tok, i) =>
    request("POST", `/shows/${show.id}/reserve`, { token: tok, body: { seats: ["A12"], idempotency_key: `hot-${RUN}-${i}` } }),
  );
  printDistribution("outcomes", results, performance.now() - t0);
  const d = distribution(results);
  check((d.confirmed ?? 0) === 1, "exactly one winner for A12", `confirmed=${d.confirmed ?? 0}`);
  check((d.seat_taken ?? 0) === HOT_USERS - 1, "every loser got a clean 409 seat_taken", `seat_taken=${d.seat_taken ?? 0}`);
  check((d["5xx"] ?? 0) + (d.network_error ?? 0) === 0, "zero 5xx / network errors");
  const after = await getShow(show.id);
  check(after.confirmed === 1 && after.available === 99, "show state matches", `confirmed=${after.confirmed} available=${after.available}`);
  check(after.available + after.held + after.confirmed === after.total_seats, "reconciliation invariant holds");
}

async function stampede(): Promise<void> {
  console.log(`\n=== 2. on-sale stampede: ${REQUESTS} requests, ${USERS} users, ${SEATS} seats, ${HOT_SEATS} hot ===`);
  const seats = seatNames("S", SEATS);
  const hot = seats.slice(0, HOT_SEATS);
  const show = await createShow(`burst-onsale-${RUN}`, seats);
  const tokens = await mintTokens(`u-${RUN}`, USERS);

  interface Plan {
    user: number;
    seats: string[];
    key: string;
  }
  const rand = (n: number) => Math.floor(Math.random() * n);
  const plans: Plan[] = [];
  let seq = 0;
  while (plans.length < REQUESTS) {
    const user = rand(USERS);
    const wanted = 1 + (Math.random() < 0.2 ? 1 : 0);
    const picks = new Set<string>();
    while (picks.size < wanted) picks.add(Math.random() < 0.5 ? hot[rand(hot.length)]! : seats[rand(seats.length)]!);
    const plan = { user, seats: [...picks], key: `s-${RUN}-${seq++}` };
    plans.push(plan);
    const roll = Math.random();
    if (roll < 0.1) plans.push({ ...plan }); // client retry: same key, same body
    else if (roll < 0.14) plans.push({ ...plan, seats: [seats[rand(seats.length)]!] }); // same key, different body
  }
  plans.length = Math.min(plans.length, REQUESTS);
  for (let i = plans.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [plans[i], plans[j]] = [plans[j]!, plans[i]!];
  }

  const before = await scrapeMetrics();
  let polling = true;
  const polls: { ok: boolean; status: number }[] = [];
  const poller = (async () => {
    while (polling) {
      const r = await request("GET", `/shows/${show.id}?seats=false`);
      const b = r.body;
      polls.push({ ok: r.status === 200 && b.available + b.held + b.confirmed === b.total_seats, status: r.status });
      await new Promise((res) => setTimeout(res, 250));
    }
  })();

  const t0 = performance.now();
  const results = await pool(plans, CONCURRENCY, (p) =>
    request("POST", `/shows/${show.id}/reserve`, {
      token: tokens[p.user]!,
      body: { seats: p.seats, idempotency_key: p.key },
    }),
  );
  const wall = performance.now() - t0;
  polling = false;
  await poller;
  printDistribution("outcomes", results, wall);

  const d = distribution(results);
  check((d["5xx"] ?? 0) === 0 && (d.network_error ?? 0) === 0, "zero 5xx / network errors across the burst", `5xx=${d["5xx"] ?? 0} net=${d.network_error ?? 0}`);
  check((d.other_400 ?? 0) + (d.other_401 ?? 0) + (d.other_404 ?? 0) === 0, "no unexpected 4xx");

  const wonBy = new Map<string, string>();
  let doubleSold = 0;
  const perUser = new Map<string, number>();
  for (const r of results.filter((x) => x.status === 201)) {
    for (const s of r.body.seats as string[]) {
      if (wonBy.has(s)) doubleSold++;
      wonBy.set(s, r.body.user_id);
    }
    perUser.set(r.body.user_id, (perUser.get(r.body.user_id) ?? 0) + r.body.seats.length);
  }
  check(doubleSold === 0, "no seat confirmed to two reservations", `seats won=${wonBy.size}`);
  check([...perUser.values()].every((n) => n <= LIMIT), `no user holds more than ${LIMIT}`, `max=${Math.max(0, ...perUser.values())}`);

  const replays = results.filter((x) => x.status === 200);
  check(replays.every((r) => r.body?.status === "confirmed"), "replays return the original reservation", `replays=${replays.length}`);

  const final = await getShow(show.id);
  check(final.available + final.held + final.confirmed === final.total_seats, "final reconciliation: available+held+confirmed == total", `${final.available}+${final.held}+${final.confirmed}=${final.total_seats}`);
  check(final.confirmed === wonBy.size, "confirmed seats == seats in 201 responses", `api=${final.confirmed} responses=${wonBy.size}`);
  const stateMatches = (final.seats as { seat: string; status: string }[]).every((s) => (s.status === "confirmed") === wonBy.has(s.seat));
  check(stateMatches, "per-seat state matches the winners exactly");
  const badPolls = polls.filter((p) => !p.ok);
  check(badPolls.length === 0, "invariant held during the burst", `${polls.length} live samples, ${badPolls.length} bad`);

  await new Promise((r) => setTimeout(r, 1200));
  const afterM = await scrapeMetrics();
  const delta = (k: string) => (afterM.get(k) ?? 0) - (before.get(k) ?? 0);
  const expectM: [string, number][] = [
    ["reservations_confirmed_total", d.confirmed ?? 0],
    ['reservations_declined_total{reason="seat_taken"}', d.seat_taken ?? 0],
    ['reservations_declined_total{reason="per_user_limit"}', d.per_user_limit ?? 0],
    ['reservations_declined_total{reason="idempotent_replay"}', d.idempotent_replay ?? 0],
    ['reservations_declined_total{reason="idempotency_key_conflict"}', d.idempotency_key_conflict ?? 0],
  ];
  console.log("\n  metrics vs observed (deltas over this phase; exact only when this is the sole traffic on one instance)");
  let metricsOk = afterM.size > 0;
  for (const [k, obs] of expectM) {
    const dm = delta(k);
    if (dm !== obs) metricsOk = false;
    console.log(`    ${k.padEnd(62)} metric=${dm} observed=${obs}`);
  }
  const g = (n: string) => afterM.get(`${n}{show_id="${show.id}"}`);
  console.log(`    seats_available gauge=${g("seats_available")} api=${final.available}; drift gauge=${g("seats_reconciliation_drift")}`);
  if (!metricsOk || g("seats_available") !== final.available) {
    warnings.push("metrics did not match observed outcomes exactly (other traffic, or several instances behind the URL?)");
  }
  check(g("seats_reconciliation_drift") === 0 || g("seats_reconciliation_drift") === undefined, "reconciliation drift gauge is 0");
}

async function perUserParallel(): Promise<void> {
  console.log(`\n=== 3. one user, 10 parallel reserves, limit ${LIMIT} ===`);
  const show = await createShow(`burst-limit-${RUN}`, seatNames("P", 20));
  const [tok] = await mintTokens(`limit-${RUN}`, 1);
  const results = await Promise.all(
    seatNames("P", 10).map((s, i) =>
      request("POST", `/shows/${show.id}/reserve`, { token: tok, body: { seats: [s], idempotency_key: `par-${RUN}-${i}` } }),
    ),
  );
  const d = distribution(results);
  console.log(`  ${JSON.stringify(d)}`);
  check((d.confirmed ?? 0) === LIMIT && (d.per_user_limit ?? 0) === 10 - LIMIT, `exactly ${LIMIT} confirmed, rest per_user_limit`);
  check((await getShow(show.id, false)).confirmed === LIMIT, `user ends with ${LIMIT} seats`);
}

async function identityAndCancel(): Promise<void> {
  console.log(`\n=== 4. identity, idempotency conflict, cancel and re-book ===`);
  const show = await createShow(`burst-id-${RUN}`, seatNames("I", 5));
  const [alice, mallory] = await mintTokens(`id-${RUN}`, 2);
  const spoof = await request("POST", `/shows/${show.id}/reserve`, {
    token: alice,
    body: { seats: ["I1"], idempotency_key: `id-${RUN}-1`, user_id: "someone-else" },
  });
  check(spoof.status === 201 && spoof.body.user_id === `id-${RUN}-0`, "spoofed user_id in body is ignored", `user=${spoof.body?.user_id}`);
  const conflict = await request("POST", `/shows/${show.id}/reserve`, {
    token: alice,
    body: { seats: ["I2"], idempotency_key: `id-${RUN}-1` },
  });
  check(conflict.status === 409 && conflict.body.error.code === "idempotency_key_conflict", "same key, different seats -> 409");
  const steal = await request("POST", `/reservations/${spoof.body.reservation_id}/cancel`, { token: mallory });
  check(steal.status === 403, "another user cannot cancel it", `status=${steal.status}`);
  const cancel = await request("POST", `/reservations/${spoof.body.reservation_id}/cancel`, { token: alice });
  check(cancel.status === 200 && cancel.body.status === "cancelled", "owner can cancel");
  const rebook = await request("POST", `/shows/${show.id}/reserve`, {
    token: mallory,
    body: { seats: ["I1"], idempotency_key: `id-${RUN}-m1` },
  });
  check(rebook.status === 201, "released seat is re-bookable by someone else");
  const late = await request("POST", `/reservations/${spoof.body.reservation_id}/cancel`, { token: alice });
  const now = await getShow(show.id);
  check(late.status === 200 && now.seats[0].status === "confirmed", "a repeated cancel does not resurrect a re-sold seat");
}

async function main(): Promise<void> {
  console.log(`target ${base.origin}  (scale=${scale} concurrency=${CONCURRENCY})`);
  const ready = await request("GET", "/readyz");
  if (ready.status !== 200) {
    console.error(`target not ready: status=${ready.status} ${ready.error ?? JSON.stringify(ready.body)}`);
    process.exit(2);
  }
  await hotSeatStorm();
  await stampede();
  await perUserParallel();
  await identityAndCancel();

  console.log("\n=== summary ===");
  for (const w of warnings) console.log(`  WARN  ${w}`);
  if (failures.length) {
    console.log(`  ${failures.length} check(s) FAILED:`);
    for (const f of failures) console.log(`    - ${f}`);
    process.exit(1);
  }
  console.log("  all checks passed");
  agent.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
