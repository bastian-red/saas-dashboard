import 'server-only';

import { effectiveBranding } from '@saas/branding';
import { workspaceSchema, type SessionUser, type Workspace } from '@saas/shared';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import { requireUser } from './session';

/**
 * The signed-in user and the workspace in the URL.
 *
 * A workspace the user is not a member of is a 404 here, exactly as the API
 * answers it (TenantGuard): "this workspace exists but is not yours" would
 * itself be a leak, since workspace slugs are guessable.
 */
export async function requireWorkspace(
  slug: string,
  next: string,
): Promise<{ user: SessionUser; workspace: Workspace }> {
  const user = await requireUser(next);
  try {
    const workspace = await apiFetch(
      user,
      `/workspaces/${encodeURIComponent(slug)}`,
      workspaceSchema,
    );
    return { user, workspace };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
}

export function listWorkspaces(user: SessionUser): Promise<Workspace[]> {
  return apiFetch(user, '/workspaces', z.array(workspaceSchema));
}

/** The base path of a workspace's pages. */
export const wsPath = (slug: string, rest = ''): string => `/w/${slug}${rest}`;

/**
 * Inline custom properties that re-point --brand at the tenant's accent. Only
 * the six `--tenant-*` names; globals.css decides where --brand is worn.
 *
 * The stored steps are NOT painted as stored: they were judged against the
 * backgrounds of the day they were saved, and the product's own palette can
 * change after that. `effectiveBranding` re-judges the stored accent against
 * today's surfaces and steps it again (or moves it to the nearest passing
 * shade, or drops it), so a tenant colour can never cost contrast, even across
 * a redesign (`lib/branding.test.ts`).
 */
export function brandingStyle(workspace: Workspace): Record<string, string> | undefined {
  const b = workspace.branding;
  if (b === null) return undefined;
  const e = effectiveBranding(b.light.accent);
  if (e.kind === 'product') return undefined;
  return {
    '--tenant-accent-light': e.light.accent,
    '--tenant-ink-light': e.light.ink,
    '--tenant-soft-light': e.light.soft,
    '--tenant-accent-dark': e.dark.accent,
    '--tenant-ink-dark': e.dark.ink,
    '--tenant-soft-dark': e.dark.soft,
  };
}
