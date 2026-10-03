/**
 * Lua scripts run by the seat cache. Redis executes each script as a single uninterrupted step, so no other
 * request can slip in between its checks and its writes.
 */

/**
 * Tries to take the hold on every requested seat at once.
 *
 * KEYS: idempotency key, held set, then one seat key per seat. ARGV: owner token, hold in ms, then the seat labels.
 *
 * Returns `{0}` acquired, `{1}` bypass (known idempotency key: let Postgres resolve replay or conflict), or
 * `{2, i, j, ...}` with the 1-based positions of seats taken by someone else. All seats or none.
 */
export const HOLD_SEATS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return {1} end
local mine = 'L|' .. ARGV[1]
local taken = {}
for i = 3, #KEYS do
  local v = redis.call('GET', KEYS[i])
  if v and v ~= mine then taken[#taken + 1] = i - 2 end
end
if #taken > 0 then return {2, unpack(taken)} end
local t = redis.call('TIME')
local expires = t[1] * 1000 + math.floor(t[2] / 1000) + tonumber(ARGV[2])
for i = 3, #KEYS do
  redis.call('SET', KEYS[i], mine, 'PX', ARGV[2])
  redis.call('ZADD', KEYS[2], expires, ARGV[i])
end
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[2]) + 60000)
return {0}
`;

/**
 * Deletes each seat key only if it still holds the expected value (compare-and-delete) and drops its held-set entry.
 *
 * KEYS: held set, then seat keys. ARGV: expected value, then the seat labels.
 */
export const RELEASE_IF_OWNER_SCRIPT = `
local n = 0
for i = 2, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then
    n = n + redis.call('DEL', KEYS[i])
    redis.call('ZREM', KEYS[1], ARGV[i])
  end
end
return n
`;

/**
 * Trims expired entries from the held set, then returns the seats whose hold is still live.
 *
 * KEYS: held set.
 */
export const LIVE_HOLDS_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
return redis.call('ZRANGE', KEYS[1], 0, -1)
`;
