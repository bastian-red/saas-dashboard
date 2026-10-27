import { can, canAssign, inviteSchema, memberSchema, PLANS, ROLES, type Role } from '@saas/shared';
import { z } from 'zod';

import { ActionForm, Submit } from '../../../../../components/action-form';
import { apiFetch } from '../../../../../lib/api';
import { formatDate } from '../../../../../lib/format';
import { viewerTimeZone } from '../../../../../lib/viewer';
import { requireWorkspace } from '../../../../../lib/workspace';
import {
  changeRoleAction,
  deleteWorkspaceAction,
  inviteAction,
  leaveWorkspaceAction,
  removeMemberAction,
  revokeInviteAction,
} from '../../../actions';

export const metadata = { title: 'Members' };

const ROLE_HELP: Record<Role, string> = {
  owner: 'everything, including billing and deleting the workspace',
  admin: 'members, keys and branding; reads the bill',
  analyst: 'builds dashboards; sees keys',
  viewer: 'reads dashboards',
};

export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { user, workspace } = await requireWorkspace(slug, `/w/${slug}/settings/members`);
  const canInvite = can(workspace.role, 'member.invite');
  const [members, invites, tz] = await Promise.all([
    apiFetch(user, `/workspaces/${slug}/members`, z.array(memberSchema)),
    canInvite
      ? apiFetch(user, `/workspaces/${slug}/invites`, z.array(inviteSchema))
      : Promise.resolve([]),
    viewerTimeZone(),
  ]);
  const seats = PLANS[workspace.plan].seats;
  const hidden = { workspace: slug };
  const assignable = ROLES.filter((r) => canAssign(workspace.role, r));

  return (
    <>
      <header className="page-head">
        <div className="page-head-text">
          <span className="crumb">{workspace.name} / Settings</span>
          <h1>Members</h1>
        </div>
        <span className="muted">
          {members.length + invites.length} of {seats} seats on {PLANS[workspace.plan].name}
        </span>
      </header>

      <section className="section" aria-labelledby="members-h">
        <h2 id="members-h" className="visually-hidden">
          People in this workspace
        </h2>
        <div className="panel table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Joined</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const me = m.userId === user.id;
                const editable =
                  !me && can(workspace.role, 'member.role') && canAssign(workspace.role, m.role);
                return (
                  <tr key={m.userId} data-testid="member-row">
                    <td>
                      {m.name}
                      {me ? <span className="muted"> (you)</span> : null}
                    </td>
                    <td className="mono">{m.email}</td>
                    <td>
                      {editable ? (
                        <ActionForm
                          action={changeRoleAction}
                          hidden={{ ...hidden, member: m.userId }}
                          className="inline-form"
                          label={`Role of ${m.name}`}
                        >
                          <select
                            className="field-select"
                            name="role"
                            defaultValue={m.role}
                            aria-label={`Role of ${m.name}`}
                          >
                            {assignable.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                          <Submit className="button button-small" pendingText="Saving">
                            Save
                          </Submit>
                        </ActionForm>
                      ) : (
                        m.role
                      )}
                    </td>
                    <td>{formatDate(m.joinedAt, tz)}</td>
                    <td>
                      {!me &&
                      can(workspace.role, 'member.remove') &&
                      canAssign(workspace.role, m.role) ? (
                        <ActionForm
                          action={removeMemberAction}
                          hidden={{ ...hidden, member: m.userId }}
                          label={`Remove ${m.name}`}
                        >
                          <Submit
                            className="button button-quiet button-small button-danger"
                            pendingText="Removing"
                          >
                            Remove
                          </Submit>
                        </ActionForm>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {canInvite ? (
        <section className="section" aria-labelledby="invite-h">
          <h2 id="invite-h">Invite someone</h2>
          <ActionForm
            action={inviteAction}
            hidden={hidden}
            className="panel inline-form"
            label="Invite someone"
          >
            <label className="field">
              <span className="field-label">Email</span>
              <input
                className="field-input"
                name="email"
                type="email"
                required
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span className="field-label">Role</span>
              <select className="field-select" name="role" defaultValue="viewer">
                {assignable.map((r) => (
                  <option key={r} value={r}>
                    {r}: {ROLE_HELP[r]}
                  </option>
                ))}
              </select>
            </label>
            <Submit pendingText="Inviting">Create invite</Submit>
          </ActionForm>
          {invites.length > 0 ? (
            <div className="panel table-scroll">
              <table className="table">
                <caption className="visually-hidden">Pending invites</caption>
                <thead>
                  <tr>
                    <th scope="col">Invited</th>
                    <th scope="col">Role</th>
                    <th scope="col">Expires</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((i) => (
                    <tr key={i.id}>
                      <td className="mono">{i.email}</td>
                      <td>{i.role}</td>
                      <td>{formatDate(i.expiresAt, tz)}</td>
                      <td>
                        <ActionForm
                          action={revokeInviteAction}
                          hidden={{ ...hidden, invite: i.id }}
                          label={`Revoke invite for ${i.email}`}
                        >
                          <Submit
                            className="button button-quiet button-small button-danger"
                            pendingText="Revoking"
                          >
                            Revoke
                          </Submit>
                        </ActionForm>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="section" aria-labelledby="leave-h">
        <h2 id="leave-h">Leave or delete</h2>
        <ActionForm action={leaveWorkspaceAction} hidden={hidden} label="Leave workspace">
          <Submit className="button" pendingText="Leaving">
            Leave {workspace.name}
          </Submit>
        </ActionForm>
        {can(workspace.role, 'workspace.delete') ? (
          <ActionForm
            action={deleteWorkspaceAction}
            hidden={hidden}
            className="panel inline-form"
            label="Delete workspace"
          >
            <label className="field">
              <span className="field-label">
                Delete this workspace, its events and its dashboards
              </span>
              <input
                className="field-input mono"
                name="confirm"
                placeholder={slug}
                autoComplete="off"
                aria-describedby="delete-hint"
              />
              <span className="field-hint" id="delete-hint">
                Type <code>{slug}</code> to confirm. This cannot be undone.
              </span>
            </label>
            <Submit className="button button-danger" pendingText="Deleting">
              Delete workspace
            </Submit>
          </ActionForm>
        ) : null}
      </section>
    </>
  );
}
