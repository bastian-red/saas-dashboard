'use client';

import type { DashboardData, Lane, LaneResult } from '@saas/shared';
import Link from 'next/link';
import {
  useCallback,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { moveLaneAction, removeLaneAction, resizeLaneAction } from '../app/w/actions';
import {
  areaPath,
  axisTicks,
  bucketAt,
  laneMax,
  linePath,
  niceMax,
  PLOT_WIDTH,
  slot,
  stackedSegments,
  yFor,
} from '../lib/chart';
import {
  formatBucket,
  formatBucketLong,
  formatCompact,
  formatError,
  formatWhole,
} from '../lib/format';
import { sentence } from '../lib/sentence';
import { ActionForm } from './action-form';

/**
 * The trace view: every lane of a dashboard on ONE time axis, and one
 * crosshair through all of them.
 *
 * The signature interaction. Point at any lane (or focus the axis and use the
 * arrow keys) and every lane's readout switches from "whole range" to its
 * value in that bucket, so "did sign-ups dip when active users did?" is
 * answered by looking down one vertical line. The bucket index is the only
 * shared state; each lane derives everything from it.
 *
 * Accessibility: the axis is a slider (role, value text, keyboard), every lane
 * is a labelled group whose name is its query sentence, the readouts are text,
 * and every lane has a table of all its values. Tooltips never gate a number.
 */

const SERIES_CLASS = ['series-1', 'series-2', 'series-3'];
const seriesClass = (name: string, i: number) =>
  name === 'Other' ? 'series-other' : (SERIES_CLASS[i] ?? 'series-other');
const PX_PER_HEIGHT_UNIT = 8;

interface TraceProps {
  readonly data: DashboardData;
  readonly lanes: readonly Lane[];
  readonly slug: string;
  readonly dashboardId: string;
  readonly canWrite: boolean;
}

export function Trace({ data, lanes, slug, dashboardId, canWrite }: TraceProps) {
  const n = data.buckets.length;
  const [index, setIndex] = useState<number | null>(null);
  const results = new Map(data.lanes.map((r) => [r.laneId, r]));

  const fromPointer = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width === 0) return;
      setIndex(bucketAt(((e.clientX - rect.left) / rect.width) * PLOT_WIDTH, n));
    },
    [n],
  );

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const page = data.bucket === 'hour' ? 24 : 7;
    const at = index ?? n - 1;
    const next =
      e.key === 'ArrowLeft'
        ? at - 1
        : e.key === 'ArrowRight'
          ? at + 1
          : e.key === 'PageUp'
            ? at - page
            : e.key === 'PageDown'
              ? at + page
              : e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? n - 1
                  : null;
    if (e.key === 'Escape') {
      setIndex(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setIndex(Math.min(n - 1, Math.max(0, next)));
  };

  const ticks = axisTicks(n);
  const cursorLabel =
    index === null ? null : formatBucket(data.buckets[index]!, data.bucket, data.tz);

  return (
    <div className="trace" onPointerLeave={() => setIndex(null)}>
      <div className="trace-row axis">
        <div className="axis-label">
          {lanes.length === 1 ? '1 lane' : `${String(lanes.length)} lanes`}
        </div>
        <div
          className="axis-track"
          role="slider"
          tabIndex={0}
          aria-label="Time cursor: read every lane at one moment"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, n - 1)}
          aria-valuenow={index ?? n - 1}
          aria-valuetext={
            index === null
              ? 'Whole range'
              : formatBucketLong(data.buckets[index]!, data.bucket, data.tz)
          }
          onKeyDown={onKey}
          onBlur={() => setIndex(null)}
          onPointerMove={fromPointer}
          onPointerDown={fromPointer}
          data-testid="axis"
        >
          {ticks.map((i) => (
            <span
              key={i}
              className="axis-tick"
              // A tick under the cursor's label is hidden, not overlapped: two
              // dates printed on top of each other read as neither.
              style={{
                left: `${String((slot(i, n).left / PLOT_WIDTH) * 100)}%`,
                visibility:
                  index !== null &&
                  Math.abs(slot(i, n).left - slot(index, n).mid) < PLOT_WIDTH * 0.07
                    ? 'hidden'
                    : undefined,
              }}
              aria-hidden="true"
            >
              {formatBucket(data.buckets[i]!, data.bucket, data.tz)}
            </span>
          ))}
          {index !== null ? (
            <span
              className="axis-cursor"
              style={{ left: `${String((slot(index, n).mid / PLOT_WIDTH) * 100)}%` }}
              aria-hidden="true"
            >
              {cursorLabel}
            </span>
          ) : null}
        </div>
        <div className="axis-readout-head" aria-live="polite" data-testid="readout-head">
          {index === null ? 'Whole range' : cursorLabel}
        </div>
      </div>

      {lanes.map((lane, position) => {
        const result = results.get(lane.id);
        return (
          <LaneRow
            key={lane.id}
            lane={lane}
            result={result}
            data={data}
            index={index}
            onPointer={fromPointer}
            tools={
              canWrite ? (
                <LaneTools
                  slug={slug}
                  dashboardId={dashboardId}
                  lane={lane}
                  first={position === 0}
                  last={position === lanes.length - 1}
                />
              ) : null
            }
          />
        );
      })}
    </div>
  );
}

function LaneRow({
  lane,
  result,
  data,
  index,
  onPointer,
  tools,
}: {
  readonly lane: Lane;
  readonly result: LaneResult | undefined;
  readonly data: DashboardData;
  readonly index: number | null;
  readonly onPointer: (e: PointerEvent<HTMLElement>) => void;
  readonly tools: ReactNode;
}) {
  const height = lane.height * PX_PER_HEIGHT_UNIT;
  const pieces = sentence(lane.spec);
  const name = lane.title ?? pieces.map((p) => p.text).join(' ');
  const labelId = `lane-${lane.id}`;

  return (
    <section
      className="trace-row lane"
      aria-labelledby={labelId}
      data-testid="lane"
      data-lane={lane.id}
    >
      <div className="lane-label">
        <h2 className="lane-title" id={labelId}>
          {name}
        </h2>
        <p className="lane-sentence">
          {pieces.map((p, i) =>
            p.kind === 'token' ? (
              <span key={i} className="token">
                {p.text}
              </span>
            ) : (
              <span key={i}> {p.text} </span>
            ),
          )}
        </p>
        {tools}
      </div>

      <div
        className="lane-plot"
        style={{ height: `${String(height)}px` }}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
      >
        {result === undefined ? null : (
          <Plot lane={lane} result={result} height={height} index={index} n={data.buckets.length} />
        )}
      </div>

      <div className="lane-readout" data-testid="readout">
        {result === undefined ? (
          <span className="readout-note">No data</span>
        ) : (
          <Readout lane={lane} result={result} index={index} />
        )}
      </div>

      {result === undefined ? null : (
        <LaneTable lane={lane} result={result} data={data} name={name} />
      )}
    </section>
  );
}

function Plot({
  lane,
  result,
  height,
  index,
  n,
}: {
  lane: Lane;
  result: LaneResult;
  height: number;
  index: number | null;
  n: number;
}) {
  const viz = lane.spec.viz;
  const stacked = viz === 'stacked';
  // A number lane's sparkline and a table lane's trend draw the per-bucket total.
  const totals = result.points.map((p) => p.reduce((a, b) => a + b, 0));
  const top = niceMax(
    viz === 'number' || viz === 'table' ? Math.max(0, ...totals) : laneMax(result.points, stacked),
  );
  const plotH = height - 2;
  const empty = result.total === 0;

  if (viz === 'table') return <BreakdownTable result={result} />;

  return (
    <>
      <svg
        className="plot-surface"
        viewBox={`0 0 ${String(PLOT_WIDTH)} ${String(height)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={empty ? 'No events in this range' : `Chart, axis up to ${formatCompact(top)}`}
      >
        {viz === 'number' ? null : (
          // Top, middle and baseline: the top is the one labelled value (plot-top).
          <>
            <line className="plot-grid" x1="0" x2={PLOT_WIDTH} y1={0.5} y2={0.5} />
            <line className="plot-grid" x1="0" x2={PLOT_WIDTH} y1={plotH / 2} y2={plotH / 2} />
            <line className="plot-grid" x1="0" x2={PLOT_WIDTH} y1={plotH - 0.5} y2={plotH - 0.5} />
          </>
        )}
        {viz === 'stacked'
          ? stackedSegments(result.points, top, plotH).map((s, i) => (
              <rect
                key={i}
                className={seriesClass(result.series[s.series] ?? '', s.series)}
                x={s.x}
                y={s.y}
                width={s.width}
                height={s.height}
                rx={2}
              />
            ))
          : null}
        {viz === 'line'
          ? result.series.map((name, s) => {
              const values = result.points.map((p) => p[s] ?? 0);
              return (
                <g key={name}>
                  {result.series.length === 1 ? (
                    <path
                      className={`plot-area ${seriesClass(name, s)}`}
                      d={areaPath(values, top, plotH)}
                    />
                  ) : null}
                  <path
                    className={`plot-line ${seriesClass(name, s)}`}
                    d={linePath(values, top, plotH)}
                  />
                </g>
              );
            })
          : null}
        {viz === 'number' ? (
          // The sparkline keeps to the lower half; the figure owns the top.
          <g transform={`translate(0 ${String(Math.round(height * 0.5))})`}>
            <path
              className="plot-area series-1"
              d={areaPath(totals, top, height - Math.round(height * 0.5) - 2)}
            />
            <path
              className="plot-line series-1"
              d={linePath(totals, top, height - Math.round(height * 0.5) - 2)}
            />
          </g>
        ) : null}
        {index !== null ? (
          <line
            className="plot-crosshair"
            x1={slot(index, n).mid}
            x2={slot(index, n).mid}
            y1={0}
            y2={height}
          />
        ) : null}
      </svg>
      {viz === 'line' && index !== null
        ? result.series.map((name, s) => (
            <Dot
              key={name}
              className={seriesClass(name, s)}
              left={slot(index, n).mid}
              top={yFor(result.points[index]?.[s] ?? 0, top, plotH)}
            />
          ))
        : null}
      {viz !== 'number' ? (
        <span className="plot-top" aria-hidden="true">
          {formatCompact(top)}
        </span>
      ) : null}
      {viz === 'number' ? (
        <div className="lane-figure">
          <strong>
            {lane.spec.metric === 'sum' && lane.spec.sumProperty === 'amount'
              ? `$${formatWhole(result.total)}`
              : formatWhole(result.total)}
          </strong>
          <span>whole range{result.error === null ? '' : `, ${formatError(result.error)}`}</span>
        </div>
      ) : null}
      {empty ? (
        <span className="plot-top" style={{ top: '45%', left: '40%' }}>
          No events in this range
        </span>
      ) : null}
    </>
  );
}

/** An end-marker at the crosshair, in HTML so the SVG's stretched x does not make it an ellipse. */
function Dot({ className, left, top }: { className: string; left: number; top: number }) {
  return (
    <svg
      className="plot-marker"
      aria-hidden="true"
      viewBox="0 0 12 12"
      style={{
        left: `calc(${String((left / PLOT_WIDTH) * 100)}% - 6px)`,
        top: `${String(top - 6)}px`,
      }}
    >
      <circle className={`plot-dot ${className}`} cx="6" cy="6" r="4" />
    </svg>
  );
}

function BreakdownTable({ result }: { result: LaneResult }) {
  const totals = result.series.map((_, s) =>
    result.points.reduce((sum, p) => sum + (p[s] ?? 0), 0),
  );
  const all = totals.reduce((a, b) => a + b, 0);
  return (
    <div className="lane-table">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Value</th>
            <th scope="col" className="num">
              Total
            </th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {result.series.map((name, s) => {
            const share = all === 0 ? 0 : totals[s]! / all;
            return (
              <tr key={name}>
                <td>{name}</td>
                <td className="num">{formatWhole(totals[s]!)}</td>
                <td>
                  <span
                    className={`share-bar readout-key ${seriesClass(name, s)}`}
                    style={{ width: `${String(Math.round(share * 120))}px` }}
                    aria-hidden="true"
                  />{' '}
                  <span className="tabular">{(share * 100).toFixed(1)}%</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Readout({
  lane,
  result,
  index,
}: {
  lane: Lane;
  result: LaneResult;
  index: number | null;
}) {
  const unique = lane.spec.metric === 'unique_users';
  const multi = result.series.length > 1;
  const at = index === null ? null : (result.points[index] ?? []);
  // Breakdown lanes are counts or sums, so the range value of a series is the
  // sum of its buckets. (Unique users have one series and the API's distinct
  // `total`; a sum of hourly uniques would count a returning person twice.)
  const valueOf = (s: number) =>
    at === null ? result.points.reduce((sum, p) => sum + (p[s] ?? 0), 0) : (at[s] ?? 0);

  return (
    <>
      {multi && unique && at === null ? (
        <span className="readout-note">
          Point at a bucket: distinct people do not add up across buckets, so this breakdown has no
          range total.
        </span>
      ) : multi ? (
        result.series.map((name, s) => (
          <div className="readout-row" key={name}>
            <span className={`readout-key ${seriesClass(name, s)}`} aria-hidden="true" />
            <span className="readout-name">{name}</span>
            <span className="readout-value" data-testid="readout-value">
              {formatCompact(valueOf(s))}
            </span>
          </div>
        ))
      ) : (
        <div className="readout-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
          <span className="readout-name">{at === null ? 'Total' : 'In bucket'}</span>
          <span className="readout-value" data-testid="readout-value">
            {formatCompact(at === null ? result.total : (at[0] ?? 0))}
          </span>
        </div>
      )}
      {unique ? (
        <span className="readout-note">
          {at === null ? 'distinct over the range, ' : ''}
          {result.error === null ? '' : `estimate ${formatError(result.error)}`}
        </span>
      ) : null}
    </>
  );
}

function LaneTable({
  lane,
  result,
  data,
  name,
}: {
  lane: Lane;
  result: LaneResult;
  data: DashboardData;
  name: string;
}) {
  return (
    <details className="lane-data">
      <summary>Table of values</summary>
      {/* Focusable: a scrolling region a keyboard cannot reach is a region it cannot read. */}
      <div className="table-scroll" tabIndex={0} role="region" aria-label={`${name}, every bucket`}>
        <table className="table">
          <caption className="visually-hidden">{name}, every bucket</caption>
          <thead>
            <tr>
              <th scope="col">{data.bucket === 'hour' ? 'Hour' : 'Day'}</th>
              {result.series.map((s) => (
                <th scope="col" className="num" key={s}>
                  {s === 'value'
                    ? lane.spec.metric === 'unique_users'
                      ? 'Unique users'
                      : lane.spec.metric === 'sum'
                        ? 'Sum'
                        : 'Count'
                    : s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.buckets.map((b, i) => (
              <tr key={b}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  {formatBucketLong(b, data.bucket, data.tz)}
                </th>
                {result.series.map((s, k) => (
                  <td className="num" key={s}>
                    {formatWhole(result.points[i]?.[k] ?? 0)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function LaneTools({
  slug,
  dashboardId,
  lane,
  first,
  last,
}: {
  slug: string;
  dashboardId: string;
  lane: Lane;
  first: boolean;
  last: boolean;
}) {
  const hidden = { workspace: slug, dashboard: dashboardId, lane: lane.id };
  const title = lane.title ?? 'lane';
  return (
    <div className="lane-tools">
      <Link
        className="button button-quiet button-small"
        href={`/w/${slug}/d/${dashboardId}?edit=${lane.id}`}
        aria-label={`Edit ${title}`}
      >
        Edit
      </Link>
      <ActionForm action={moveLaneAction} hidden={{ ...hidden, direction: 'up' }}>
        <button
          className="button button-quiet button-small"
          type="submit"
          disabled={first}
          aria-label={`Move ${title} up`}
        >
          ↑
        </button>
      </ActionForm>
      <ActionForm action={moveLaneAction} hidden={{ ...hidden, direction: 'down' }}>
        <button
          className="button button-quiet button-small"
          type="submit"
          disabled={last}
          aria-label={`Move ${title} down`}
        >
          ↓
        </button>
      </ActionForm>
      <ActionForm
        action={resizeLaneAction}
        hidden={{ ...hidden, height: String(Math.max(10, lane.height - 4)) }}
      >
        <button
          className="button button-quiet button-small"
          type="submit"
          disabled={lane.height <= 10}
          aria-label={`Make ${title} shorter`}
        >
          −
        </button>
      </ActionForm>
      <ActionForm
        action={resizeLaneAction}
        hidden={{ ...hidden, height: String(Math.min(60, lane.height + 4)) }}
      >
        <button
          className="button button-quiet button-small"
          type="submit"
          disabled={lane.height >= 60}
          aria-label={`Make ${title} taller`}
        >
          +
        </button>
      </ActionForm>
      <ActionForm action={removeLaneAction} hidden={hidden}>
        <button
          className="button button-quiet button-small button-danger"
          type="submit"
          aria-label={`Remove ${title}`}
        >
          Remove
        </button>
      </ActionForm>
    </div>
  );
}
