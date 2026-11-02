/**
 * The hosted demo publishes one read-only login. DEMO_PINNED_USERS keeps it in
 * its workspace, so one visitor cannot hand every later visitor an empty
 * account; everyone else still leaves as before.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionUser } from '@saas/shared';

import { addMember, boot, call, newUser, newWorkspace, type Harness } from './support';

let harness: Harness;
let owner: SessionUser;
let pinned: SessionUser;
let other: SessionUser;
let slug: string;
let workspaceId: string;
const previous = process.env.DEMO_PINNED_USERS;
const pinnedEmail = `Pinned-${randomUUID().slice(0, 8)}@saas.test`;

beforeAll(async () => {
  // The config is parsed when the app boots, so the list is set before boot.
  // Mixed case on purpose: the match is on the lowercased address.
  process.env.DEMO_PINNED_USERS = `someone@else.test, ${pinnedEmail}`;
  harness = await boot();
  owner = await newUser(harness.db, 'pin-owner');
  other = await newUser(harness.db, 'pin-other');
  const row = await harness.db.user.create({
    data: { email: pinnedEmail.toLowerCase(), name: 'pinned', passwordHash: 'not-a-real-hash' },
    select: { id: true },
  });
  pinned = { id: row.id, email: pinnedEmail.toLowerCase(), name: 'pinned' };
  const w = await newWorkspace(harness, owner, 'pin');
  slug = w.slug;
  workspaceId = w.id;
  await addMember(harness, owner, slug, pinned, 'viewer');
  await addMember(harness, owner, slug, other, 'viewer');
});

afterAll(async () => {
  if (previous === undefined) delete process.env.DEMO_PINNED_USERS;
  else process.env.DEMO_PINNED_USERS = previous;
  await harness.db.tenant.deleteMany({ where: { id: workspaceId } });
  await harness.db.user.deleteMany({ where: { id: { in: [owner.id, pinned.id, other.id] } } });
  await harness.close();
});

describe('a pinned demo login', () => {
  it('cannot leave its workspace, and is told why in words', async () => {
    const r = await call<{ code: string; message: string }>(
      harness,
      'DELETE',
      `/workspaces/${slug}/membership`,
      { user: pinned },
    );
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
    expect(r.body.message).toMatch(/shared demo login/u);
    const still = await harness.db.membership.findUnique({
      where: { tenantId_userId: { tenantId: workspaceId, userId: pinned.id } },
    });
    expect(still?.role).toBe('viewer');
  });

  it('does not stop anyone else leaving', async () => {
    const r = await call(harness, 'DELETE', `/workspaces/${slug}/membership`, { user: other });
    expect(r.status).toBe(204);
  });
});
