'use client';

import { laneSpecSchema, METRICS, VIZ, type Lane, type LaneSpec } from '@saas/shared';
import Link from 'next/link';
import { useState } from 'react';

import { saveLaneAction } from '../app/w/actions';
import { METRIC_LABEL, VIZ_LABEL } from '../lib/sentence';
import { ActionForm, Submit } from './action-form';

export interface Catalog {
  events: { name: string; count: number }[];
  properties: { event: string; property: string; kind: 'string' | 'number' }[];
}

/**
 * The sentence editor. A lane's query is written the way it is read:
 *
 *   [Unique users who did] [page_viewed] where [plan] [is] [team] by [device] [as a line]
 *
 * Every bracket is a native control (keyboard, screen reader and autofill all
 * work with no custom widget to get wrong), styled as a token in the sentence.
 * The pickers only offer what this workspace has actually sent (the catalog
 * of the last 90 days), so a lane cannot be built on an event that does not
 * exist; the shared schema decides whether the sentence is complete, the
 * same schema the API validates with.
 */
export function LaneEditor({
  slug,
  dashboardId,
  lane,
  catalog,
}: {
  slug: string;
  dashboardId: string;
  lane: Lane | null;
  catalog: Catalog;
}) {
  const initial: LaneSpec = lane?.spec ?? {
    metric: 'count',
    event: catalog.events[0]?.name ?? '',
    sumProperty: null,
    breakdown: null,
    filters: [],
    viz: 'line',
  };
  const [spec, setSpec] = useState<LaneSpec>(initial);
  const [title, setTitle] = useState(lane?.title ?? '');

  const propsOf = (kind: 'string' | 'number') =>
    catalog.properties
      .filter((p) => p.event === spec.event && p.kind === kind)
      .map((p) => p.property);
  const strings = propsOf('string');
  const numbers = propsOf('number');
  const events =
    catalog.events.some((e) => e.name === spec.event) || spec.event === ''
      ? catalog.events.map((e) => e.name)
      : [spec.event, ...catalog.events.map((e) => e.name)];
  const filter = spec.filters[0] ?? null;

  const set = (patch: Partial<LaneSpec>) => setSpec((s) => ({ ...s, ...patch }));
  const changeEvent = (event: string) =>
    // Properties belong to an event; picking another event resets the ones it may not have.
    setSpec((s) => ({
      ...s,
      event,
      sumProperty:
        s.metric === 'sum'
          ? (catalog.properties.find((p) => p.event === event && p.kind === 'number')?.property ??
            null)
          : null,
      breakdown: null,
      filters: [],
    }));
  const changeMetric = (metric: LaneSpec['metric']) =>
    set({ metric, sumProperty: metric === 'sum' ? (numbers[0] ?? null) : null });

  const parsed = laneSpecSchema.safeParse(spec);
  const problem = parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Incomplete');

  return (
    <ActionForm
      action={saveLaneAction}
      className="editor"
      hidden={{
        workspace: slug,
        dashboard: dashboardId,
        lane: lane?.id ?? '',
        spec: JSON.stringify(spec),
      }}
      label={lane === null ? 'New lane' : 'Edit lane'}
    >
      <h2>{lane === null ? 'New lane' : 'Edit lane'}</h2>
      <div className="editor-sentence">
        <select
          className="token-select"
          aria-label="Metric"
          value={spec.metric}
          onChange={(e) => changeMetric(e.target.value as LaneSpec['metric'])}
        >
          {METRICS.map((m) => (
            <option key={m} value={m}>
              {m === 'sum' ? 'Sum of' : METRIC_LABEL[m]}
            </option>
          ))}
        </select>
        {spec.metric === 'sum' ? (
          <>
            <select
              className="token-select"
              aria-label="Numeric property to sum"
              value={spec.sumProperty ?? ''}
              onChange={(e) => set({ sumProperty: e.target.value || null })}
            >
              {numbers.length === 0 ? <option value="">no numeric property</option> : null}
              {numbers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <span>on</span>
          </>
        ) : null}
        <select
          className="token-select"
          aria-label="Event"
          value={spec.event}
          onChange={(e) => changeEvent(e.target.value)}
        >
          {events.length === 0 ? <option value="">no events yet</option> : null}
          {events.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
        {filter === null ? null : (
          <>
            <span>where</span>
            <select
              className="token-select"
              aria-label="Filter property"
              value={filter.property}
              onChange={(e) => set({ filters: [{ ...filter, property: e.target.value }] })}
            >
              {strings.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              className="token-select"
              aria-label="Filter comparison"
              value={filter.op}
              onChange={(e) =>
                set({ filters: [{ ...filter, op: e.target.value as 'eq' | 'neq' }] })
              }
            >
              <option value="eq">is</option>
              <option value="neq">is not</option>
            </select>
            <input
              className="token-input"
              aria-label="Filter value"
              value={filter.value}
              maxLength={256}
              onChange={(e) => set({ filters: [{ ...filter, value: e.target.value }] })}
            />
          </>
        )}
        <span>by</span>
        <select
          className="token-select"
          aria-label="Break down by"
          value={spec.breakdown ?? ''}
          onChange={(e) =>
            set({
              breakdown: e.target.value || null,
              viz: !e.target.value && spec.viz === 'stacked' ? 'line' : spec.viz,
            })
          }
        >
          <option value="">nothing</option>
          {strings.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          className="token-select"
          aria-label="Show as"
          value={spec.viz}
          onChange={(e) => set({ viz: e.target.value as LaneSpec['viz'] })}
        >
          {VIZ.map((v) => (
            <option key={v} value={v} disabled={v === 'stacked' && spec.breakdown === null}>
              {VIZ_LABEL[v]}
            </option>
          ))}
        </select>
      </div>

      <div className="editor-row">
        {filter === null ? (
          <button
            className="button button-small"
            type="button"
            disabled={strings.length === 0}
            onClick={() => set({ filters: [{ property: strings[0] ?? '', op: 'eq', value: '' }] })}
          >
            + Filter
          </button>
        ) : (
          <button
            className="button button-small"
            type="button"
            onClick={() => set({ filters: [] })}
          >
            Remove filter
          </button>
        )}
        <label className="field" style={{ flex: '1 1 14rem' }}>
          <span className="field-label">Title (optional)</span>
          <input
            className="field-input"
            name="title"
            maxLength={80}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Defaults to the sentence"
          />
        </label>
      </div>

      {problem !== null ? (
        <p className="field-hint" role="status">
          Not complete: {problem}.
        </p>
      ) : null}
      <div className="editor-row">
        {problem === null ? (
          <Submit pendingText="Saving">{lane === null ? 'Add lane' : 'Save lane'}</Submit>
        ) : (
          <button className="button button-primary" type="button" disabled aria-disabled="true">
            {lane === null ? 'Add lane' : 'Save lane'}
          </button>
        )}
        <Link className="button" href={`/w/${slug}/d/${dashboardId}`}>
          Cancel
        </Link>
      </div>
    </ActionForm>
  );
}
