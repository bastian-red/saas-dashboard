/**
 * HyperLogLog, precision 11: 2,048 one-byte registers, relative standard error
 * 1.04 / sqrt(2048) = 2.3%.
 *
 * Written here rather than taken from npm: the sketch is a storage format. The
 * aggregator writes it into `event_hours.users_hll` (bytea, exactly 2,048
 * bytes, a CHECK pins it) and the API merges sketches from many hours at query
 * time, so the register layout is a contract between two services and a
 * migration, and the maintained packages each serialise differently or not at
 * all. Sixty lines with a test against exact counts is the smaller risk.
 *
 * Input is a user hash that is already uniform (16 bytes of SHA-256), so the
 * first 8 bytes are used as the 64-bit hash directly: the top 11 bits pick the
 * register, the position of the first 1 in the remaining 53 bits is the rank.
 */

export const PRECISION = 11;
export const REGISTERS = 1 << PRECISION;
export const STANDARD_ERROR = 1.04 / Math.sqrt(REGISTERS);

const ALPHA = 0.7213 / (1 + 1.079 / REGISTERS);
/** 2^-r for every possible register value: the estimator's inner loop is a table lookup. */
const INVERSE_POWERS = Float64Array.from({ length: 66 }, (_, r) => 2 ** -r);

export function emptySketch(): Uint8Array {
  return new Uint8Array(REGISTERS);
}

/** Add one 16-byte user hash to `sketch`, in place. */
export function addHash(sketch: Uint8Array, hash: Uint8Array): void {
  if (hash.length < 8) throw new Error('a user hash is at least 8 bytes');
  const hi = ((hash[0]! << 24) | (hash[1]! << 16) | (hash[2]! << 8) | hash[3]!) >>> 0;
  const lo = ((hash[4]! << 24) | (hash[5]! << 16) | (hash[6]! << 8) | hash[7]!) >>> 0;
  const index = hi >>> (32 - PRECISION);
  // The 53 bits after the index: 21 from `hi`, all 32 of `lo`.
  const restHi = hi & ((1 << (32 - PRECISION)) - 1);
  let rank: number;
  if (restHi !== 0) rank = Math.clz32(restHi) - PRECISION + 1;
  else if (lo !== 0) rank = 32 - PRECISION + Math.clz32(lo) + 1;
  else rank = 64 - PRECISION + 1;
  if (rank > sketch[index]!) sketch[index] = rank;
}

/** Register-wise max: the union of the two sets. In place on `into`. */
export function mergeInto(into: Uint8Array, from: Uint8Array): void {
  if (from.length !== REGISTERS || into.length !== REGISTERS)
    throw new Error(`a sketch is ${String(REGISTERS)} bytes`);
  for (let i = 0; i < REGISTERS; i += 1) if (from[i]! > into[i]!) into[i] = from[i]!;
}

export function estimate(sketch: Uint8Array): number {
  let sum = 0;
  let zeros = 0;
  for (let i = 0; i < REGISTERS; i += 1) {
    const r = sketch[i]!;
    sum += INVERSE_POWERS[r]!;
    if (r === 0) zeros += 1;
  }
  const raw = (ALPHA * REGISTERS * REGISTERS) / sum;
  // Small-range correction: linear counting is far more accurate while many
  // registers are still empty.
  if (raw <= 2.5 * REGISTERS && zeros > 0)
    return Math.round(REGISTERS * Math.log(REGISTERS / zeros));
  return Math.round(raw);
}
