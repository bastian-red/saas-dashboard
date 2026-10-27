import { z } from 'zod';

/**
 * The small shapes every other contract is built from.
 *
 * Everything here is a zod schema with its TypeScript type derived by `z.infer`.
 * Never a hand-written interface beside a schema: the two drift, and the one
 * that drifts is always the one that is not validated.
 */

/** A cuid, which is what every `@id @default(cuid())` in the schema produces. */
export const idSchema = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[a-z0-9]+$/u);

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const nameSchema = z.string().trim().min(1).max(80);

/**
 * At least 12 characters. Not a composition rule -- no "one digit, one symbol" --
 * because those push people towards `Password1!` and measurably lower entropy.
 * Length is the property that matters.
 */
export const passwordSchema = z.string().min(12).max(200);

/** A tenant id: a v4 UUID, because RLS policies compare it as `uuid`. */
export const tenantIdSchema = z.string().uuid();

/**
 * A workspace slug, as it appears in the app's URLs (`/w/acme/...`). Lowercase so
 * a link read aloud still works.
 */
export const workspaceSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{2,39}$/u, 'a slug: 3-40 of a-z 0-9 -');

/** A hex colour, `#rrggbb`. */
export const hexColourSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/u, 'a colour like #5a4590')
  .transform((v) => v.toLowerCase());

/** An ISO 8601 instant. Always UTC on the wire; rendering picks a zone. */
export const instantSchema = z.string().datetime();

export type Id = z.infer<typeof idSchema>;
export type TenantId = z.infer<typeof tenantIdSchema>;
