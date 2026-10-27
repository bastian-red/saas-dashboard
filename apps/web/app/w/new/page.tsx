import Link from 'next/link';

import { ActionForm, Submit } from '../../../components/action-form';
import { Brand } from '../../../components/brand';
import { requireUser } from '../../../lib/session';
import { listWorkspaces } from '../../../lib/workspace';
import { createWorkspaceAction } from '../actions';

export const metadata = { title: 'New workspace' };

/** Create a workspace. Its creator is its first owner; it starts on the Free plan. */
export default async function NewWorkspacePage() {
  const user = await requireUser('/w/new');
  const existing = await listWorkspaces(user);
  return (
    <main id="main" className="auth-page">
      <div className="auth-card">
        <Brand />
        <h1 className="auth-title">New workspace</h1>
        <p className="muted">
          A workspace holds one product&apos;s events, its dashboards and its team. Everything in it
          is visible only to its members.
        </p>
        <ActionForm action={createWorkspaceAction} className="auth-form">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="field-input"
              name="name"
              required
              maxLength={80}
              autoComplete="organization"
            />
          </label>
          <label className="field">
            <span className="field-label">Address</span>
            <input
              className="field-input mono"
              name="slug"
              required
              minLength={3}
              maxLength={40}
              pattern="[a-z0-9][a-z0-9\-]{2,39}"
              aria-describedby="slug-hint"
            />
            <span className="field-hint" id="slug-hint">
              /w/your-address. Lowercase letters, digits and dashes.
            </span>
          </label>
          <Submit pendingText="Creating">Create workspace</Submit>
        </ActionForm>
        {existing.length > 0 ? (
          <p className="auth-switch">
            Or go back to <Link href={`/w/${existing[0]!.slug}`}>{existing[0]!.name}</Link>.
          </p>
        ) : null}
      </div>
    </main>
  );
}
