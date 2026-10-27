import { apiKeySchema, can } from '@saas/shared';
import { z } from 'zod';

import { ActionForm, Submit } from '../../../../../components/action-form';
import { apiFetch } from '../../../../../lib/api';
import { ingestPublicUrl } from '../../../../../lib/config';
import { formatDate } from '../../../../../lib/format';
import { viewerTimeZone } from '../../../../../lib/viewer';
import { requireWorkspace } from '../../../../../lib/workspace';
import { createKeyAction, revokeKeyAction } from '../../../actions';

export const metadata = { title: 'API keys' };

export default async function KeysPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { user, workspace } = await requireWorkspace(slug, `/w/${slug}/settings/keys`);
  const [keys, tz] = await Promise.all([
    apiFetch(user, `/workspaces/${slug}/api-keys`, z.array(apiKeySchema)),
    viewerTimeZone(),
  ]);
  const canWrite = can(workspace.role, 'apikey.write');
  const hidden = { workspace: slug };
  const curl = `curl -X POST ${ingestPublicUrl}/v1/events \\
  -H "Authorization: Bearer $SAAS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"events":[{"event":"signed_up","userId":"u_123","properties":{"source":"organic"}}]}'`;

  return (
    <>
      <header className="page-head">
        <div className="page-head-text">
          <span className="crumb">{workspace.name} / Settings</span>
          <h1>API keys</h1>
        </div>
      </header>

      <section className="section" aria-labelledby="send-h">
        <h2 id="send-h">Send events</h2>
        <p className="muted">
          Batches of up to 500 events. A <code>202</code> means they are on disk; they reach the
          dashboards within a few seconds.
        </p>
        <code className="snippet">{curl}</code>
      </section>

      <section className="section" aria-labelledby="keys-h">
        <h2 id="keys-h">Keys</h2>
        {keys.length === 0 ? (
          <p className="muted">No keys yet.</p>
        ) : (
          <div className="panel table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Key</th>
                  <th scope="col">Created</th>
                  <th scope="col">Last used</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td className="mono">{k.prefix}…</td>
                    <td>{formatDate(k.createdAt, tz)}</td>
                    <td>
                      {k.lastUsedAt === null ? (
                        <span className="muted">never</span>
                      ) : (
                        formatDate(k.lastUsedAt, tz)
                      )}
                    </td>
                    <td>
                      {canWrite ? (
                        <ActionForm
                          action={revokeKeyAction}
                          hidden={{ ...hidden, key: k.id }}
                          label={`Revoke ${k.name}`}
                        >
                          <Submit
                            className="button button-quiet button-small button-danger"
                            pendingText="Revoking"
                          >
                            Revoke
                          </Submit>
                        </ActionForm>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canWrite ? (
          <ActionForm
            action={createKeyAction}
            hidden={hidden}
            className="panel inline-form"
            label="Create a key"
          >
            <label className="field">
              <span className="field-label">New key name</span>
              <input
                className="field-input"
                name="name"
                required
                maxLength={60}
                placeholder="Production backend"
              />
            </label>
            <Submit pendingText="Creating">Create key</Submit>
          </ActionForm>
        ) : (
          <p className="muted">Only owners and admins create or revoke keys.</p>
        )}
      </section>
    </>
  );
}
