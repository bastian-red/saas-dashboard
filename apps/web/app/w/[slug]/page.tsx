import { can, dashboardSummarySchema } from '@saas/shared';
import Link from 'next/link';
import { z } from 'zod';

import { ActionForm, Submit } from '../../../components/action-form';
import { apiFetch } from '../../../lib/api';
import { formatDate } from '../../../lib/format';
import { viewerTimeZone } from '../../../lib/viewer';
import { requireWorkspace } from '../../../lib/workspace';
import { createDashboardAction } from '../actions';

export const metadata = { title: 'Dashboards' };

export default async function DashboardsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { user, workspace } = await requireWorkspace(slug, `/w/${slug}`);
  const [dashboards, tz] = await Promise.all([
    apiFetch(user, `/workspaces/${slug}/dashboards`, z.array(dashboardSummarySchema)),
    viewerTimeZone(),
  ]);
  const canWrite = can(workspace.role, 'dashboard.write');

  return (
    <>
      <header className="page-head">
        <div className="page-head-text">
          <span className="crumb">{workspace.name}</span>
          <h1>Dashboards</h1>
        </div>
      </header>

      {dashboards.length === 0 ? (
        <div className="panel empty">
          <p>No dashboards yet.</p>
          <p>
            Send events with an <Link href={`/w/${slug}/settings/keys`}>API key</Link>, then line
            them up here.
          </p>
        </div>
      ) : (
        <ul className="dash-list">
          {dashboards.map((d) => (
            <li key={d.id}>
              <Link href={`/w/${slug}/d/${d.id}`}>
                <span className="dash-name">{d.name}</span>
                <span className="dash-lanes" aria-label={`${String(d.lanes)} lanes`}>
                  {Array.from({ length: Math.min(d.lanes, 8) }, (_, i) => (
                    <span key={i} />
                  ))}
                </span>
                <span className="muted">
                  {d.lanes} {d.lanes === 1 ? 'lane' : 'lanes'} · updated{' '}
                  {formatDate(d.updatedAt, tz)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {canWrite ? (
        <section className="section" style={{ marginTop: '2rem' }} aria-labelledby="new-dashboard">
          <h2 id="new-dashboard">New dashboard</h2>
          <ActionForm
            action={createDashboardAction}
            hidden={{ workspace: slug }}
            className="inline-form"
          >
            <label className="field">
              <span className="field-label">Name</span>
              <input
                className="field-input"
                name="name"
                required
                maxLength={80}
                placeholder="Activation funnel"
              />
            </label>
            <Submit pendingText="Creating">Create</Submit>
          </ActionForm>
        </section>
      ) : null}
    </>
  );
}
