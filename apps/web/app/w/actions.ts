'use server';

/**
 * Every write the workspace pages make, as server actions.
 *
 * Each one re-derives the user from the session and calls the API with a
 * service token; the API's TenantGuard decides membership and role on every
 * call. The UI hides what a role cannot do, but hiding is a courtesy: a viewer
 * who posts this form by hand gets the API's 403, rendered as an alert.
 *
 * The workspace slug and ids arrive as form fields and go into API paths
 * through `encodeURIComponent` only after a format check, so a crafted value
 * cannot walk the path to another route.
 */
import {
  createdApiKeySchema,
  createdInviteSchema,
  dashboardSchema,
  laneSpecSchema,
  memberSchema,
  rangeSchema,
  redirectUrlSchema,
  roleSchema,
  workspaceSchema,
  workspaceSlugSchema,
} from '@saas/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { auth } from '../../auth';
import { ApiError, apiFetch } from '../../lib/api';
import { appBaseUrl } from '../../lib/config';
import type { FormState } from '../../lib/form-state';

const ID = /^[a-z0-9]{20,40}$/u;
const nothing = z.unknown();

async function user() {
  const session = await auth();
  if (!session?.user) redirect('/sign-in');
  return session.user;
}

function slugOf(form: FormData): string {
  const slug = workspaceSlugSchema.safeParse(form.get('workspace'));
  if (!slug.success) throw new Error('missing workspace');
  return slug.data;
}

function idOf(form: FormData, name: string): string {
  const value = String(form.get(name) ?? '');
  if (!ID.test(value)) throw new Error(`missing ${name}`);
  return value;
}

/** An API refusal as the sentence the API wrote; anything else as a generic retry. */
function failure(error: unknown): FormState {
  if (error instanceof ApiError) {
    if (error.status === 429) return { error: 'Too many requests. Wait a minute and try again.' };
    if (error.status >= 500) {
      console.error('[web] action failed:', error);
      return { error: 'Something went wrong on the server. Try again in a moment.' };
    }
    return { error: error.message };
  }
  console.error('[web] action failed:', error);
  return { error: 'Something went wrong. Try again in a moment.' };
}

const base = (slug: string) => `/workspaces/${encodeURIComponent(slug)}`;

// --- workspaces ---------------------------------------------------------------------

export async function createWorkspaceAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const name = String(form.get('name') ?? '').trim();
  const slug = String(form.get('slug') ?? '')
    .trim()
    .toLowerCase();
  if (!workspaceSlugSchema.safeParse(slug).success)
    return {
      error:
        'The address must be 3 to 40 characters: a-z, 0-9 and dashes, starting with a letter or digit.',
    };
  let created;
  try {
    created = await apiFetch(me, '/workspaces', workspaceSchema, {
      method: 'POST',
      body: { name, slug },
    });
  } catch (error) {
    return failure(error);
  }
  redirect(`/w/${created.slug}`);
}

export async function acceptInviteAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  let ws;
  try {
    ws = await apiFetch(me, '/workspaces/invites/accept', workspaceSchema, {
      method: 'POST',
      body: { token: String(form.get('token') ?? '') },
    });
  } catch (error) {
    return failure(error);
  }
  redirect(`/w/${ws.slug}`);
}

export async function leaveWorkspaceAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  try {
    await apiFetch(me, `${base(slug)}/membership`, nothing, { method: 'DELETE' });
  } catch (error) {
    return failure(error);
  }
  redirect('/');
}

export async function deleteWorkspaceAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  if (String(form.get('confirm') ?? '') !== slug) return { error: `Type ${slug} to confirm.` };
  try {
    await apiFetch(me, base(slug), nothing, { method: 'DELETE' });
  } catch (error) {
    return failure(error);
  }
  redirect('/');
}

// --- dashboards ----------------------------------------------------------------------

export async function createDashboardAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  let d;
  try {
    d = await apiFetch(me, `${base(slug)}/dashboards`, dashboardSchema, {
      method: 'POST',
      body: { name: String(form.get('name') ?? '') },
    });
  } catch (error) {
    return failure(error);
  }
  redirect(`/w/${slug}/d/${d.id}`);
}

export async function updateDashboardAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  const id = idOf(form, 'dashboard');
  const body: { name?: string; range?: string } = {};
  if (form.has('name')) body.name = String(form.get('name'));
  if (form.has('range')) body.range = rangeSchema.parse(form.get('range'));
  try {
    await apiFetch(me, `${base(slug)}/dashboards/${id}`, dashboardSchema, {
      method: 'PATCH',
      body,
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/w/${slug}/d/${id}`);
  return { error: null };
}

export async function deleteDashboardAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  const id = idOf(form, 'dashboard');
  try {
    await apiFetch(me, `${base(slug)}/dashboards/${id}`, nothing, { method: 'DELETE' });
  } catch (error) {
    return failure(error);
  }
  redirect(`/w/${slug}`);
}

// --- lanes ----------------------------------------------------------------------------

/** The editor posts the spec as one JSON field; it is parsed with the shared schema before it leaves. */
function specOf(form: FormData) {
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get('spec') ?? ''));
  } catch {
    return null;
  }
  const parsed = laneSpecSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function titleOf(form: FormData): string | null {
  const t = String(form.get('title') ?? '').trim();
  return t === '' ? null : t.slice(0, 80);
}

export async function saveLaneAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  const id = idOf(form, 'dashboard');
  const spec = specOf(form);
  if (spec === null)
    return {
      error:
        'That lane is not complete yet: a sum needs a numeric property, and stacked columns need a breakdown.',
    };
  const lane = String(form.get('lane') ?? '');
  try {
    if (ID.test(lane)) {
      await apiFetch(me, `${base(slug)}/dashboards/${id}/lanes/${lane}`, dashboardSchema, {
        method: 'PATCH',
        body: { title: titleOf(form), spec },
      });
    } else {
      await apiFetch(me, `${base(slug)}/dashboards/${id}/lanes`, dashboardSchema, {
        method: 'POST',
        body: { title: titleOf(form), spec },
      });
    }
  } catch (error) {
    return failure(error);
  }
  redirect(`/w/${slug}/d/${id}`);
}

export async function moveLaneAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  const id = idOf(form, 'dashboard');
  const lane = idOf(form, 'lane');
  const direction = form.get('direction') === 'up' ? -1 : 1;
  try {
    const d = await apiFetch(me, `${base(slug)}/dashboards/${id}`, dashboardSchema);
    const order = d.lanes.map((l) => l.id);
    const at = order.indexOf(lane);
    const to = at + direction;
    if (at < 0 || to < 0 || to >= order.length) return { error: null };
    [order[at], order[to]] = [order[to]!, order[at]!];
    await apiFetch(me, `${base(slug)}/dashboards/${id}/lanes/order`, dashboardSchema, {
      method: 'PUT',
      body: { order },
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/w/${slug}/d/${id}`);
  return { error: null };
}

export async function resizeLaneAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  const id = idOf(form, 'dashboard');
  const lane = idOf(form, 'lane');
  const height = Math.min(60, Math.max(10, Number(form.get('height'))));
  if (!Number.isInteger(height)) return { error: 'Not a lane height.' };
  try {
    await apiFetch(me, `${base(slug)}/dashboards/${id}/lanes/${lane}`, dashboardSchema, {
      method: 'PATCH',
      body: { height },
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/w/${slug}/d/${id}`);
  return { error: null };
}

export async function removeLaneAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  const id = idOf(form, 'dashboard');
  const lane = idOf(form, 'lane');
  try {
    await apiFetch(me, `${base(slug)}/dashboards/${id}/lanes/${lane}`, dashboardSchema, {
      method: 'DELETE',
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/w/${slug}/d/${id}`);
  return { error: null };
}

// --- members and invites -----------------------------------------------------------------

export async function inviteAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  const role = roleSchema.safeParse(form.get('role'));
  if (!role.success) return { error: 'Choose a role.' };
  let invite;
  try {
    invite = await apiFetch(me, `${base(slug)}/invites`, createdInviteSchema, {
      method: 'POST',
      body: { email: String(form.get('email') ?? ''), role: role.data },
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/w/${slug}/settings/members`);
  return {
    error: null,
    notice: `Invite for ${invite.email} created. Send this link; it is shown once and works for 7 days.`,
    secret: `${appBaseUrl}/invite/${invite.token}`,
  };
}

export async function revokeInviteAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  try {
    await apiFetch(me, `${base(slug)}/invites/${idOf(form, 'invite')}`, nothing, {
      method: 'DELETE',
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/w/${slug}/settings/members`);
  return { error: null };
}

export async function changeRoleAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  const role = roleSchema.safeParse(form.get('role'));
  if (!role.success) return { error: 'Choose a role.' };
  try {
    await apiFetch(me, `${base(slug)}/members/${idOf(form, 'member')}`, memberSchema, {
      method: 'PATCH',
      body: { role: role.data },
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/w/${slug}/settings/members`);
  return { error: null, notice: 'Role changed.' };
}

export async function removeMemberAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  try {
    await apiFetch(me, `${base(slug)}/members/${idOf(form, 'member')}`, nothing, {
      method: 'DELETE',
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/w/${slug}/settings/members`);
  return { error: null };
}

// --- API keys ---------------------------------------------------------------------------

export async function createKeyAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  let key;
  try {
    key = await apiFetch(me, `${base(slug)}/api-keys`, createdApiKeySchema, {
      method: 'POST',
      body: { name: String(form.get('name') ?? '') },
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/w/${slug}/settings/keys`);
  return {
    error: null,
    notice: `Key "${key.name}" created. Copy it now: it is shown once, and only its hash is stored.`,
    secret: key.key,
  };
}

export async function revokeKeyAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  try {
    await apiFetch(me, `${base(slug)}/api-keys/${idOf(form, 'key')}`, nothing, {
      method: 'DELETE',
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/w/${slug}/settings/keys`);
  return { error: null };
}

// --- billing and branding ------------------------------------------------------------------

export async function checkoutAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  const plan = z.enum(['team', 'business']).safeParse(form.get('plan'));
  if (!plan.success) return { error: 'Choose a plan.' };
  let url;
  try {
    ({ url } = await apiFetch(me, `${base(slug)}/billing/checkout`, redirectUrlSchema, {
      method: 'POST',
      body: { plan: plan.data },
    }));
  } catch (error) {
    return failure(error);
  }
  redirect(url);
}

export async function portalAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  let url;
  try {
    ({ url } = await apiFetch(me, `${base(slug)}/billing/portal`, redirectUrlSchema, {
      method: 'POST',
    }));
  } catch (error) {
    return failure(error);
  }
  redirect(url);
}

/**
 * The mock provider's "Pay" / "Cancel subscription" buttons. The API turns
 * this into a signed webhook delivery to itself, through the same path a real
 * Stripe event takes.
 */
export async function mockBillingAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  const plan = z.enum(['team', 'business']).safeParse(form.get('plan'));
  const status = z.enum(['active', 'canceled']).safeParse(form.get('status'));
  if (!plan.success || !status.success) return { error: 'Not a plan.' };
  try {
    await apiFetch(me, `${base(slug)}/billing/mock`, z.object({ outcome: z.string() }), {
      method: 'POST',
      body: { plan: plan.data, status: status.data },
    });
  } catch (error) {
    return failure(error);
  }
  redirect(
    `/w/${slug}/settings/billing?checkout=${status.data === 'active' ? 'success' : 'canceled'}`,
  );
}

export async function brandingAction(_p: FormState, form: FormData): Promise<FormState> {
  const me = await user();
  const slug = slugOf(form);
  const reset = form.get('intent') === 'reset';
  const accent = reset ? null : String(form.get('accent') ?? '').toLowerCase();
  try {
    await apiFetch(me, `${base(slug)}/branding`, z.unknown(), { method: 'PUT', body: { accent } });
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) {
      const details = error.details as { issues?: unknown; suggestion?: unknown } | undefined;
      const issues = Array.isArray(details?.issues)
        ? details.issues.filter((i): i is string => typeof i === 'string')
        : [];
      const suggestion =
        typeof details?.suggestion === 'string'
          ? ` Try ${details.suggestion}, the nearest shade that passes.`
          : '';
      return { error: `${error.message} ${issues.join(' ')}${suggestion}`.trim() };
    }
    return failure(error);
  }
  revalidatePath(`/w/${slug}`, 'layout');
  return {
    error: null,
    notice: reset
      ? 'Back to the product colour.'
      : `${accent ?? ''} is now this workspace's accent.`,
  };
}
