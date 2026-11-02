/**
 * The browser's address, as the web server vouches for it.
 *
 * The API rate-limits anonymous calls (sign-in, sign-up) per address, and every
 * one of them reaches it through the web server. `x-forwarded-for` cannot carry
 * that address on a public host: the API is reachable directly too, and any
 * caller can write the header, so trusting enough proxy hops to reach the web
 * server's entry also lets a direct caller pick its own address and walk around
 * the five-per-minute sign-in budget.
 *
 * So the web server signs what it forwards. The value is
 * `v1;<address>;<unix seconds>;<HMAC-SHA256 over the rest, base64url>`, keyed by
 * the AUTH_SECRET the two processes already share. The API keys an anonymous
 * budget on a value that verifies and falls back to the transport address
 * (`req.ip`, which `TRUST_PROXY_HOPS` stops at the host's own edge) for anything
 * else. A direct caller cannot sign, so it is limited by the address it really
 * connects from.
 *
 * The timestamp bounds replay to a minute either side. The header never reaches
 * a browser (server-to-server only), so a captured value is no more useful than
 * the address in it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const CLIENT_ADDRESS_HEADER = 'x-saas-client-address';
export const CLIENT_ADDRESS_MAX_SKEW_SECONDS = 60;

const VERSION = 'v1';

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`client-address:${payload}`).digest();
}

export function signClientAddress(
  address: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  if (isIP(address) === 0) throw new Error(`not an IP address: ${address}`);
  const payload = `${VERSION};${address};${String(nowSeconds)}`;
  return `${payload};${mac(secret, payload).toString('base64url')}`;
}

/** The vouched-for address, or null for anything that does not verify. Never throws. */
export function verifyClientAddress(
  value: string | undefined | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  const parts = value.split(';');
  if (parts.length !== 4) return null;
  const [version, address, stamp, signature] = parts as [string, string, string, string];
  if (version !== VERSION || isIP(address) === 0 || !/^\d{1,12}$/u.test(stamp)) return null;
  if (Math.abs(nowSeconds - Number(stamp)) > CLIENT_ADDRESS_MAX_SKEW_SECONDS) return null;

  const expected = mac(secret, `${version};${address};${stamp}`);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return address;
}
