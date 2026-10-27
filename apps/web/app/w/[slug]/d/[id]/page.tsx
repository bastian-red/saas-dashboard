import { can, dashboardDataSchema, dashboardSchema, RANGES, type RangeKey } from '@saas/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { ActionForm, Submit } from '../../../../../components/action-form';
import { LaneEditor, type Catalog } from '../../../../../components/lane-editor';
import { Trace } from '../../../../../components/trace';
import { ApiError, apiFetch, query } from '../../../../../lib/api';
import { viewerTimeZone } from '../../../../../lib/viewer';
import { requireWorkspace } from '../../../../../lib/workspace';
import { deleteDashboardAction, updateDashboardAction } from '../../../actions';

const catalogSchema = z.object({
  events: z.array(z.object({ name: z.string(), count: z.number() })),
  properties: z.array(
    z.object({ event: z.string(), property: z.string(), kind: z.enum(['string', 'number']) }),
  ),
});

const RANGE_LABEL: Record<RangeKey, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
};
const ID = /^[a-z0-9]{20,40}$/u;

export async function generateMetadata() {
  return { title: 'Dashboard' };
}

/**
 * One dashboard: its range, its lanes on one axis, and (for analysts and up)
 * the sentence editor, opened in place with `?edit=<lane id>` or `?edit=new`
 * so a lane being edited is a URL a colleague can be sent.
 */
export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const { slug, id } = await params;
  const { edit } = await searchParams;
  if (!ID.test(id)) notFound();
  const { user, workspace } = await requireWorkspace(slug, `/w/${slug}/d/${id}`);
  const tz = await viewerTimeZone();
  const base = `/workspaces/${slug}/dashboards/${id}`;
  const canWrite = can(workspace.role, 'dashboard.write');

  let dashboard, data;
  try {
    [dashboard, data] = await Promise.all([
      apiFetch(user, base, dashboardSchema),
      apiFetch(user, `${base}/data${query({ tz })}`, dashboardDataSchema),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const editing =
    canWrite && edit !== undefined
      ? edit === 'new'
        ? null
        : (dashboard.lanes.find((l) => l.id === edit) ?? undefined)
      : undefined;
  const catalog: Catalog | null =
    editing !== undefined
      ? await apiFetch(user, `/workspaces/${slug}/catalog`, catalogSchema)
      : null;
  const hidden = { workspace: slug, dashboard: id };

  return (
    <>
      <header className="page-head">
        <div className="page-head-text">
          <Link className="crumb" href={`/w/${slug}`}>
            {workspace.name} / Dashboards
          </Link>
          <h1>{dashboard.name}</h1>
        </div>
        {canWrite ? (
          <div className="inline-form">
            <Link className="button button-primary" href={`/w/${slug}/d/${id}?edit=new`}>
              + Add lane
            </Link>
          </div>
        ) : null}
      </header>

      <div className="controls">
        {canWrite ? (
          <ActionForm action={updateDashboardAction} hidden={hidden} label="Time range">
            <div className="segmented" role="group" aria-label="Time range">
              {RANGES.map((r) => (
                <button
                  key={r}
                  type="submit"
                  name="range"
                  value={r}
                  aria-pressed={dashboard.range === r}
                >
                  {RANGE_LABEL[r]}
                </button>
              ))}
            </div>
          </ActionForm>
        ) : (
          <span className="muted">Last {RANGE_LABEL[dashboard.range]}</span>
        )}
        <span className="muted">
          {data.bucket === 'hour' ? 'Hourly' : 'Daily'} buckets, {tz}
        </span>
      </div>

      {editing !== undefined && catalog !== null ? (
        <div className="section">
          <LaneEditor slug={slug} dashboardId={id} lane={editing} catalog={catalog} />
        </div>
      ) : null}

      {dashboard.lanes.length === 0 ? (
        <div className="trace empty">
          <p>This dashboard has no lanes yet.</p>
          {canWrite ? (
            <Link className="button button-primary" href={`/w/${slug}/d/${id}?edit=new`}>
              Add the first lane
            </Link>
          ) : null}
        </div>
      ) : (
        <Trace
          data={data}
          lanes={dashboard.lanes}
          slug={slug}
          dashboardId={id}
          canWrite={canWrite}
        />
      )}

      {canWrite ? (
        <details className="section" style={{ marginTop: '2rem' }}>
          <summary className="muted">Rename or delete this dashboard</summary>
          <ActionForm
            action={updateDashboardAction}
            hidden={hidden}
            className="inline-form"
            label="Rename dashboard"
          >
            <label className="field">
              <span className="field-label">Name</span>
              <input
                className="field-input"
                name="name"
                defaultValue={dashboard.name}
                required
                maxLength={80}
              />
            </label>
            <Submit className="button" pendingText="Saving">
              Rename
            </Submit>
          </ActionForm>
          <ActionForm action={deleteDashboardAction} hidden={hidden} label="Delete dashboard">
            <Submit className="button button-danger" pendingText="Deleting">
              Delete dashboard
            </Submit>
          </ActionForm>
        </details>
      ) : null}
    </>
  );
}
