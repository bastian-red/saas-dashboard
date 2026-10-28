'use client';

import type { DashboardData, Lane, LaneResult } from '@saas/shared';
import Link from 'next/link';
import {
  useCallback,
  useId,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { moveLaneAction, removeLaneAction, resizeLaneAction } from '../app/w/actions';
import {
  areaPath,
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
import { bucketTotals, formatChange, rollCall, VERDICT_DISPLAY, type Call } from '../lib/rollcall';
import { sentence } from '../lib/sentence';
import { calendarTicks } from '../lib/ticks';
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

  const ticks = calendarTicks(data.buckets, data.bucket, data.tz);
  const calls = new Map(
    data.lanes.map((r) => [r.laneId, rollCall(bucketTotals(r.points), data.bucket)] as const),
  );
  const cursorLabel =
    index === null ? null : formatBucket(data.buckets[index]!, data.bucket, data.tz);

  return (
    <>
      <RollCall lanes={lanes} calls={calls} data={data} />
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
            {ticks.map((tick) => (
              <span
                key={tick.index}
                className="axis-tick"
                data-testid="axis-tick"
                // A tick under the cursor's label is hidden, not overlapped: two
                // dates printed on top of each other read as neither.
                style={{
                  left: `${String((slot(tick.index, n).left / PLOT_WIDTH) * 100)}%`,
                  visibility:
                    index !== null &&
                    Math.abs(slot(tick.index, n).left - slot(index, n).mid) < PLOT_WIDTH * 0.07
                      ? 'hidden'
                      : undefined,
                }}
                aria-hidden="true"
              >
                {tick.label}
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
              call={calls.get(lane.id)}
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
    </>
  );
}

/** "Tue 27 Oct" for a day bucket, "Wed 14:00" for an hour bucket: the bucket the roll call judged. */
function judgedLabel(data: DashboardData, call: Call | undefined): string | null {
  if (call?.index == null) return null;
  return formatBucketLong(data.buckets[call.index]!, data.bucket, data.tz);
}

/**
 * The roll call: the first thing on the dashboard, so the morning question
 * ("did anything move?") is answered before anyone reads a chart. Each lane
 * answers up, down, steady or no baseline, as a glyph AND a word; a lane that
 * moved wears the accent, because "moved" is the thing to look at, not "good"
 * or "bad" (sign-ups up is good news, errors up is not). Each entry jumps to
 * its lane. `lib/rollcall.ts` says how a verdict is reached.
 */
function RollCall({
  lanes,
  calls,
  data,
}: {
  lanes: readonly Lane[];
  calls: ReadonlyMap<string, Call>;
  data: DashboardData;
}) {
  if (lanes.length === 0) return null;
  const first = calls.values().next().value as Call | undefined;
  const judged = judgedLabel(data, first);
  const moved = lanes.filter((l) => {
    const v = calls.get(l.id)?.verdict;
    return v === 'up' || v === 'down';
  }).length;
  const baseline =
    data.bucket === 'day' ? 'the same weekday in earlier weeks' : 'the same hour on earlier days';
  return (
    <section className="rollcall" aria-labelledby="rollcall-title" data-testid="rollcall">
      <div className="rollcall-head">
        <h2 id="rollcall-title" className="rollcall-title">
          Roll call
        </h2>
        <p className="rollcall-summary">
          <strong>
            {moved === 0
              ? 'Nothing moved'
              : moved === 1
                ? '1 lane moved'
                : `${String(moved)} lanes moved`}
          </strong>
          {judged === null ? null : (
            <>
              {' '}
              · {judged} against {baseline}
            </>
          )}
        </p>
      </div>
      <ol className="rollcall-list">
        {lanes.map((lane) => {
          const call = calls.get(lane.id);
          const verdict = call?.verdict ?? 'unknown';
          const display = VERDICT_DISPLAY[verdict];
          const name =
            lane.title ??
            sentence(lane.spec)
              .map((p) => p.text)
              .join(' ');
          return (
            <li key={lane.id}>
              <a className="rollcall-entry" href={`#row-${lane.id}`} data-verdict={verdict}>
                <span className="verdict" data-verdict={verdict}>
                  <span aria-hidden="true">{display.glyph}</span> {display.word}
                  {call !== undefined && (verdict === 'up' || verdict === 'down')
                    ? ` ${formatChange(call)}`
                    : ''}
                </span>
                <span className="rollcall-name">{name}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The verdict at the head of a lane, with the two numbers it was reached from. */
function LaneVerdict({ call, data }: { call: Call | undefined; data: DashboardData }) {
  const verdict = call?.verdict ?? 'unknown';
  const display = VERDICT_DISPLAY[verdict];
  return (
    <p className="lane-verdict" data-testid="lane-verdict" data-verdict={verdict}>
      <span className="verdict" data-verdict={verdict}>
        <span aria-hidden="true">{display.glyph}</span> {display.word}
        {call !== undefined && (verdict === 'up' || verdict === 'down')
          ? ` ${formatChange(call)}`
          : ''}
      </span>
      {call === undefined || call.index === null ? null : verdict === 'unknown' ? (
        <span className="lane-verdict-detail">Not enough earlier {data.bucket}s to compare</span>
      ) : (
        <span className="lane-verdict-detail">
          {judgedLabel(data, call)}: {formatCompact(call.latest)} against a typical{' '}
          {formatCompact(call.typical)}
          {call.range === null
            ? ''
            : `; steady from ${formatCompact(call.range.low)} to ${formatCompact(call.range.high)}`}
        </span>
      )}
    </p>
  );
}

function LaneRow({
  lane,
  result,
  data,
  index,
  call,
  onPointer,
  tools,
}: {
  readonly lane: Lane;
  readonly result: LaneResult | undefined;
  readonly data: DashboardData;
  readonly index: number | null;
  readonly call: Call | undefined;
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
      id={`row-${lane.id}`}
    >
      <div className="lane-label">
        <h2 className="lane-title" id={labelId}>
          {name}
        </h2>
        <LaneVerdict call={call} data={data} />
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
        data-viz={lane.spec.viz}
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

  if (viz === 'number') {
    // The figure owns its own row and the sparkline takes the rest of the lane
    // below it: drawn over the line, a peak ran through the digits. e2e
    // layout.spec.ts asserts the two boxes never intersect.
    return (
      <>
        <div className="lane-figure" data-testid="lane-figure">
          <strong>
            {lane.spec.metric === 'sum' && lane.spec.sumProperty === 'amount'
              ? `$${formatWhole(result.total)}`
              : formatWhole(result.total)}
          </strong>
          <span>whole range{result.error === null ? '' : `, ${formatError(result.error)}`}</span>
        </div>
        <svg
          className="plot-surface number-spark"
          data-testid="number-spark"
          viewBox={`0 0 ${String(PLOT_WIDTH)} ${String(height)}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={empty ? 'No events in this range' : 'Trend over the range'}
        >
          <path className="plot-area series-1" d={areaPath(totals, top, height - 2)} />
          <path className="plot-line series-1" d={linePath(totals, top, height - 2)} />
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
      </>
    );
  }

  return (
    <>
      <svg
        className="plot-surface"
        viewBox={`0 0 ${String(PLOT_WIDTH)} ${String(height)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={empty ? 'No events in this range' : `Chart, axis up to ${formatCompact(top)}`}
      >
        {
          // Top, middle and baseline: the top is the one labelled value (plot-top).
          <>
            <line className="plot-grid" x1="0" x2={PLOT_WIDTH} y1={0.5} y2={0.5} />
            <line className="plot-grid" x1="0" x2={PLOT_WIDTH} y1={plotH / 2} y2={plotH / 2} />
            <line className="plot-grid" x1="0" x2={PLOT_WIDTH} y1={plotH - 0.5} y2={plotH - 0.5} />
          </>
        }
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
      <span className="plot-top" aria-hidden="true">
        {formatCompact(top)}
      </span>
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

/**
 * A lane's tools. Edit is the one thing done often, so it stays visible; the
 * rest (move, resize, remove) live in one labelled menu instead of a row of
 * bare glyphs, and Remove asks once more, in words, before it acts: it used to
 * sit, always red, one stray click from deleting a lane.
 */
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
  const [confirming, setConfirming] = useState(false);
  const confirmId = useId();
  return (
    <div className="lane-tools">
      <Link
        className="button button-quiet button-small"
        href={`/w/${slug}/d/${dashboardId}?edit=${lane.id}`}
        aria-label={`Edit ${title}`}
      >
        Edit
      </Link>
      <details
        className="lane-menu"
        onToggle={(e) => !e.currentTarget.open && setConfirming(false)}
      >
        <summary className="button button-quiet button-small" aria-label={`More for ${title}`}>
          More
        </summary>
        <div className="lane-menu-body">
          <ActionForm action={moveLaneAction} hidden={{ ...hidden, direction: 'up' }}>
            <button
              className="menu-item"
              type="submit"
              disabled={first}
              aria-label={`Move ${title} up`}
            >
              <span aria-hidden="true">↑</span> Move up
            </button>
          </ActionForm>
          <ActionForm action={moveLaneAction} hidden={{ ...hidden, direction: 'down' }}>
            <button
              className="menu-item"
              type="submit"
              disabled={last}
              aria-label={`Move ${title} down`}
            >
              <span aria-hidden="true">↓</span> Move down
            </button>
          </ActionForm>
          <ActionForm
            action={resizeLaneAction}
            hidden={{ ...hidden, height: String(Math.max(10, lane.height - 4)) }}
          >
            <button
              className="menu-item"
              type="submit"
              disabled={lane.height <= 10}
              aria-label={`Make ${title} shorter`}
            >
              <span aria-hidden="true">−</span> Shorter
            </button>
          </ActionForm>
          <ActionForm
            action={resizeLaneAction}
            hidden={{ ...hidden, height: String(Math.min(60, lane.height + 4)) }}
          >
            <button
              className="menu-item"
              type="submit"
              disabled={lane.height >= 60}
              aria-label={`Make ${title} taller`}
            >
              <span aria-hidden="true">+</span> Taller
            </button>
          </ActionForm>
          <div className="menu-separator" role="separator" />
          {confirming ? (
            <ActionForm action={removeLaneAction} hidden={hidden} className="menu-confirm">
              <p id={confirmId} className="menu-confirm-text">
                Remove <strong>{title}</strong> from this dashboard? Its events are kept.
              </p>
              <div className="inline-form">
                <button
                  className="button button-small button-danger-solid"
                  type="submit"
                  aria-label={`Remove ${title}`}
                  aria-describedby={confirmId}
                >
                  Remove lane
                </button>
                <button
                  className="button button-small"
                  type="button"
                  onClick={() => setConfirming(false)}
                >
                  Keep it
                </button>
              </div>
            </ActionForm>
          ) : (
            <button
              className="menu-item menu-item-danger"
              type="button"
              onClick={() => setConfirming(true)}
              aria-label={`Remove ${title}…`}
            >
              <span aria-hidden="true">✕</span> Remove…
            </button>
          )}
        </div>
      </details>
    </div>
  );
}
