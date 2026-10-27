import 'server-only';

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
 * the six `--tenant-*` names, whose values the API validated (and stepped for
 * both schemes) before storing; globals.css decides where --brand is worn.
 */
export function brandingStyle(workspace: Workspace): Record<string, string> | undefined {
  const b = workspace.branding;
  if (b === null) return undefined;
  return {
    '--tenant-accent-light': b.light.accent,
    '--tenant-ink-light': b.light.ink,
    '--tenant-soft-light': b.light.soft,
    '--tenant-accent-dark': b.dark.accent,
    '--tenant-ink-dark': b.dark.ink,
    '--tenant-soft-dark': b.dark.soft,
  };
}
