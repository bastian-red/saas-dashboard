import { createHash, randomBytes } from 'node:crypto';

/** A random secret and its storage form. The raw value is returned once and never stored. */
export function newSecret(prefix: string, bytes = 24): { raw: string; hash: string } {
  const raw = `${prefix}${randomBytes(bytes).toString('base64url')}`;
  return { raw, hash: sha256(raw) };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
