import { workspaceSlugSchema } from '@saas/shared';

/**
 * The mock provider's pages receive return URLs the API built
 * (`<app>/w/<slug>/settings/billing?...`). The workspace is read back out of
 * that path, never trusted from a separate parameter, and only a path of
 * exactly that shape is accepted, so the page cannot be pointed at another
 * route or another origin.
 */
const RETURN = /^\/w\/([a-z0-9][a-z0-9-]{2,39})\/settings\/billing$/u;

export function slugFromReturnUrl(raw: string | undefined, appBaseUrl: string): string | null {
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== new URL(appBaseUrl).origin) return null;
  const m = RETURN.exec(url.pathname);
  if (m === null) return null;
  return workspaceSlugSchema.safeParse(m[1]).success ? m[1]! : null;
}
