/**
 * HMAC signing for the mock gateway's webhooks.
 *
 * The header format is deliberately Stripe's: `t=<unix seconds>,v1=<hex mac>`,
 * with the MAC taken over `${timestamp}.${rawBody}`. Copying the format is not
 * decoration; it means the API's verification path, the replay-window policy and
 * the failure modes are the same shape under both drivers, so the mock proves
 * something about the real one.
 *
 * Two properties are load-bearing:
 *
 *  - The timestamp is inside the MAC. Signing the body alone would let anyone who
 *    captured one valid request replay it forever.
 *  - Comparison is `timingSafeEqual`. A byte-by-byte `===` on a MAC leaks how
 *    many leading bytes were right, which is enough to forge one over enough
 *    requests.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookSignatureError } from './types';

/** How far a signature timestamp may drift before the request is refused. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Stripe's own header name, so a proxy or log filter treats both drivers alike. */
export const SIGNATURE_HEADER = 'stripe-signature';

function computeMac(secret: string, timestamp: number, payload: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

/** Build the header value for a payload. `timestamp` is injectable for tests. */
export function signPayload(
  payload: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  return `t=${timestamp},v1=${computeMac(secret, timestamp, payload)}`;
}

interface ParsedSignature {
  timestamp: number;
  macs: string[];
}

function parseSignatureHeader(header: string): ParsedSignature {
  let timestamp: number | undefined;
  const macs: string[] = [];
  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === 'v1') {
      macs.push(value);
    }
  }
  if (timestamp === undefined || macs.length === 0) {
    throw new WebhookSignatureError('Malformed signature header');
  }
  return { timestamp, macs };
}

function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself be a leak;
  // the length check is safe to do first because MAC length is not a secret.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify a signature header over a raw body. Throws `WebhookSignatureError` on
 * any failure, which callers map to 400: a bad signature never becomes good on
 * a retry, so it must not be answered with a retryable status.
 */
export function verifySignature(
  rawBody: Buffer | string,
  header: string,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): void {
  if (!secret) throw new WebhookSignatureError('No signing secret configured');
  if (!header) throw new WebhookSignatureError('Missing signature header');

  const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const { timestamp, macs } = parseSignatureHeader(header);

  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    throw new WebhookSignatureError('Signature timestamp outside tolerance');
  }

  const expected = computeMac(secret, timestamp, payload);
  // A provider may send several v1 values during secret rotation; any match wins.
  if (!macs.some((mac) => equalsConstantTime(mac, expected))) {
    throw new WebhookSignatureError('Signature mismatch');
  }
}
