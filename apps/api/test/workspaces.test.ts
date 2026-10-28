/**
 * Accounts, workspaces, members, invites, branding: the flows and their edges,
 * at the documented budgets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionUser, Workspace } from '@saas/shared';

import {
  addMember,
  boot,
  call,
  newUser,
  newWorkspace,
  randomAddress,
  type Harness,
} from './support';

let harness: Harness;
let owner: SessionUser;
const users: string[] = [];
const workspaces: string[] = [];

async function user(label: string): Promise<SessionUser> {
  const u = await newUser(harness.db, label);
  users.push(u.id);
  return u;
}

async function ws(o: SessionUser, label: string) {
  const w = await newWorkspace(harness, o, label);
  workspaces.push(w.id);
  return w;
}

beforeAll(async () => {
  harness = await boot();
  owner = await user('ws-owner');
});

afterAll(async () => {
  await harness.db.tenant.deleteMany({ where: { id: { in: workspaces } } });
  await harness.db.user.deleteMany({ where: { id: { in: users } } });
  await harness.close();
});

describe('sign up and the auth budget', () => {
  it('creates an account, refuses a duplicate address, and limits sign-in per address without limiting the rest', async () => {
    const email = `signup-${String(Date.now())}@saas.test`;
    const created = await call<{ id: string }>(harness, 'POST', '/auth/sign-up', {
      user: null,
      body: { email, name: 'New', password: 'a-long-enough-password' },
    });
    expect(created.status).toBe(201);
    users.push(created.body.id);
    expect(
      (
        await call(harness, 'POST', '/auth/sign-up', {
          user: null,
          body: { email, name: 'Dup', password: 'a-long-enough-password' },
        })
      ).status,
    ).toBe(409);

    const address = randomAddress();
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push(
        (
          await call(harness, 'POST', '/auth/sign-in', {
            user: null,
            address,
            body: { email, password: 'wrong-password-123' },
          })
        ).status,
      );
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
    expect((await call(harness, 'GET', '/workspaces', { user: owner, address })).status).toBe(200);
    expect((await call(harness, 'GET', '/health', { user: null, address })).status).toBe(200);
  });
});

describe('workspaces', () => {
  it('creates one with its creator as owner, and refuses a taken address', async () => {
    const w = await ws(owner, 'acme');
    const list = await call<Workspace[]>(harness, 'GET', '/workspaces', { user: owner });
    expect(list.body.find((x) => x.slug === w.slug)).toMatchObject({
      role: 'owner',
      plan: 'free',
      branding: null,
    });
    const dup = await call(harness, 'POST', '/workspaces', {
      user: await user('ws-other'),
      body: { name: 'x', slug: w.slug },
    });
    expect(dup.status).toBe(409);
  });

  it('cannot lose its last owner: demoting or removing them is refused', async () => {
    const w = await ws(owner, 'solo');
    const demote = await call(harness, 'PATCH', `/workspaces/${w.slug}/members/${owner.id}`, {
      user: owner,
      body: { role: 'admin' },
    });
    expect(demote.status).toBe(422);
    expect(
      (await call(harness, 'DELETE', `/workspaces/${w.slug}/membership`, { user: owner })).status,
    ).toBe(422);
  });

  it('lets an owner be demoted once there is another owner', async () => {
    const w = await ws(owner, 'duo');
    const second = await user('ws-second');
    await addMember(harness, owner, w.slug, second, 'owner');
    expect(
      (
        await call(harness, 'PATCH', `/workspaces/${w.slug}/members/${owner.id}`, {
          user: second,
          body: { role: 'admin' },
        })
      ).status,
    ).toBe(200);
  });

  it('does not let an admin promote anyone to owner or touch an owner', async () => {
    const w = await ws(owner, 'adm');
    const admin = await user('ws-admin');
    const viewer = await user('ws-viewer');
    await addMember(harness, owner, w.slug, admin, 'admin');
    await addMember(harness, owner, w.slug, viewer, 'viewer');
    expect(
      (
        await call(harness, 'PATCH', `/workspaces/${w.slug}/members/${viewer.id}`, {
          user: admin,
          body: { role: 'owner' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(harness, 'PATCH', `/workspaces/${w.slug}/members/${owner.id}`, {
          user: admin,
          body: { role: 'viewer' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(harness, 'PATCH', `/workspaces/${w.slug}/members/${viewer.id}`, {
          user: admin,
          body: { role: 'analyst' },
        })
      ).status,
    ).toBe(200);
  });
});

describe('invites', () => {
  it('count against the plan seats while pending', async () => {
    const w = await ws(owner, 'seats');
    const a = await call(harness, 'POST', `/workspaces/${w.slug}/invites`, {
      user: owner,
      body: { email: 'one@saas.test', role: 'viewer' },
    });
    const b = await call(harness, 'POST', `/workspaces/${w.slug}/invites`, {
      user: owner,
      body: { email: 'two@saas.test', role: 'viewer' },
    });
    const c = await call<{ message: string }>(harness, 'POST', `/workspaces/${w.slug}/invites`, {
      user: owner,
      body: { email: 'three@saas.test', role: 'viewer' },
    });
    expect([a.status, b.status, c.status]).toEqual([201, 201, 422]);
    expect(c.body.message).toContain('3 seats');
  });

  it('can be accepted once, only by the invited address', async () => {
    const w = await ws(owner, 'inv');
    const invited = await user('ws-invited');
    const stranger = await user('ws-stranger');
    const inv = await call<{ token: string }>(harness, 'POST', `/workspaces/${w.slug}/invites`, {
      user: owner,
      body: { email: invited.email, role: 'analyst' },
    });
    expect(
      (
        await call(harness, 'POST', '/workspaces/invites/accept', {
          user: stranger,
          body: { token: inv.body.token },
        })
      ).status,
    ).toBe(403);
    // Two tabs at once: exactly one wins.
    const [x, y] = await Promise.all([
      call(harness, 'POST', '/workspaces/invites/accept', {
        user: invited,
        body: { token: inv.body.token },
      }),
      call(harness, 'POST', '/workspaces/invites/accept', {
        user: invited,
        body: { token: inv.body.token },
      }),
    ]);
    expect([x.status, y.status].filter((s) => s === 200)).toHaveLength(1);
    expect(
      (
        await call(harness, 'POST', '/workspaces/invites/accept', {
          user: invited,
          body: { token: inv.body.token },
        })
      ).status,
    ).toBe(410);
    expect(
      (
        await call(harness, 'POST', '/workspaces/invites/accept', {
          user: invited,
          body: { token: 'inv_not_a_real_token_at_all' },
        })
      ).status,
    ).toBe(404);
  });

  it('are limited by the invite budget, separately from everything else', async () => {
    // A fresh owner: the budget is per user per minute, and this file's other
    // tests have already spent some of `owner`'s.
    const spammer = await user('ws-spammer');
    const w = await ws(spammer, 'spam');
    await call(harness, 'POST', `/workspaces/${w.slug}/billing/mock`, {
      user: spammer,
      body: { plan: 'business' },
    });
    const statuses = [];
    for (let i = 0; i < 21; i += 1) {
      statuses.push(
        (
          await call(harness, 'POST', `/workspaces/${w.slug}/invites`, {
            user: spammer,
            body: { email: `s${String(i)}@saas.test`, role: 'viewer' },
          })
        ).status,
      );
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(20);
    expect(statuses[20]).toBe(429);
    expect(
      (await call(harness, 'GET', `/workspaces/${w.slug}/members`, { user: spammer })).status,
    ).toBe(200);
  });
});

describe('branding', () => {
  it('stores an accent with its derived dark step, and refuses one that fails contrast with a suggestion', async () => {
    const w = await ws(owner, 'brand');
    const ok = await call<{ dark: { accent: string } }>(
      harness,
      'PUT',
      `/workspaces/${w.slug}/branding`,
      { user: owner, body: { accent: '#5A4590' } },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.dark.accent).toBe('#8d7aca');
    const list = await call<Workspace[]>(harness, 'GET', '/workspaces', { user: owner });
    expect(list.body.find((x) => x.slug === w.slug)?.branding?.light.accent).toBe('#5a4590');

    const bad = await call<{ details: { issues: string[]; suggestion: string } }>(
      harness,
      'PUT',
      `/workspaces/${w.slug}/branding`,
      { user: owner, body: { accent: '#2563eb' } },
    );
    expect(bad.status).toBe(422);
    expect(bad.body.details).toEqual({
      field: 'accent',
      issues: [
        'light: #2563eb on the page (#d0d9db) is 3.60:1, needs 4.5:1',
        'light: #2563eb on panels (#dfe5e7) is 4.06:1, needs 4.5:1',
      ],
      suggestion: '#1451d8',
    });

    expect(
      (
        await call(harness, 'PUT', `/workspaces/${w.slug}/branding`, {
          user: owner,
          body: { accent: null },
        })
      ).status,
    ).toBe(200);
  });
});
