-- One ingest batch, one round trip: the workspace's EVENT rate and its
-- monthly event quota, checked and charged atomically.
--
-- The rate is GCRA over events, not requests: a batch of n events costs n
-- emission intervals. Charging per request let a Free workspace (20 events/s)
-- send 20 batches of 500 every second, 10,000 events/s; scripts/loadtest.sh
-- found it by flooding at 10x the plan and never being refused.
--
-- KEYS[1] rate:{tenant}            GCRA theoretical arrival time, ms
-- KEYS[2] quota:{tenant}:{yyyymm}  events accepted this month
--
-- ARGV[1] now, epoch ms
-- ARGV[2] emission interval ms per EVENT (1000 / events per second)
-- ARGV[3] burst tolerance ms
-- ARGV[4] events in this batch
-- ARGV[5] the plan's monthly quota
-- ARGV[6] seconds until the month's counter may expire (end of month + a day)
--
-- Replies:
--   {"rate", retry_after_ms}       too many events too fast; nothing charged
--   {"quota", used, limit}         the whole batch would cross the quota; nothing charged
--   {"ok", used_after}
--
-- All or nothing per batch: a batch that would cross the quota is refused
-- entire, never half-stored, so a client's retry logic has one case to handle.
-- Atomic because Redis runs a script without interleaving, which is the whole
-- reason two concurrent batches cannot both take the last 100 events.

local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local tolerance = tonumber(ARGV[3])
local n = tonumber(ARGV[4])
local limit = tonumber(ARGV[5])

local tat = tonumber(redis.call('GET', KEYS[1])) or now
if tat < now then tat = now end
local cost = interval * n
local allow_at = tat + cost - tolerance
if allow_at > now then
  return {'rate', tostring(math.ceil(allow_at - now))}
end

local used = tonumber(redis.call('GET', KEYS[2])) or 0
if used + n > limit then
  return {'quota', tostring(used), tostring(limit)}
end

local new_tat = tat + cost
redis.call('SET', KEYS[1], tostring(new_tat), 'PX', math.max(1, math.ceil(new_tat - now)))
local after = redis.call('INCRBY', KEYS[2], n)
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[6]))
return {'ok', tostring(after)}
