import type { LaneSpec } from '@saas/shared';

/**
 * A lane's query as the sentence the editor shows: "**Unique users** who did
 * **page_viewed**, by **device**". Each emphasised word is a token the editor
 * turns into a picker; the plain words are glue. Also the lane's accessible
 * name, so a screen reader hears the same sentence a sighted reader sees.
 */

export type Piece =
  | { kind: 'glue'; text: string }
  | { kind: 'token'; field: keyof LaneSpec | 'filter'; text: string };

export const METRIC_LABEL: Record<LaneSpec['metric'], string> = {
  count: 'Count of',
  unique_users: 'Unique users who did',
  sum: 'Sum of',
};

export const VIZ_LABEL: Record<LaneSpec['viz'], string> = {
  line: 'as a line',
  stacked: 'as stacked columns',
  number: 'as a number',
  table: 'as a table',
};

export function sentence(spec: LaneSpec): Piece[] {
  const out: Piece[] = [];
  if (spec.metric === 'sum') {
    out.push({ kind: 'token', field: 'metric', text: 'Sum of' });
    out.push({ kind: 'token', field: 'sumProperty', text: spec.sumProperty ?? '?' });
    out.push({ kind: 'glue', text: 'on' });
  } else {
    out.push({ kind: 'token', field: 'metric', text: METRIC_LABEL[spec.metric] });
  }
  out.push({ kind: 'token', field: 'event', text: spec.event });
  for (const f of spec.filters) {
    out.push({ kind: 'glue', text: 'where' });
    out.push({
      kind: 'token',
      field: 'filter',
      text: `${f.property} ${f.op === 'eq' ? 'is' : 'is not'} ${f.value}`,
    });
  }
  if (spec.breakdown !== null) {
    out.push({ kind: 'glue', text: 'by' });
    out.push({ kind: 'token', field: 'breakdown', text: spec.breakdown });
  }
  out.push({ kind: 'token', field: 'viz', text: VIZ_LABEL[spec.viz] });
  return out;
}

/** The sentence as plain text. */
export function sentenceText(spec: LaneSpec): string {
  return sentence(spec)
    .map((p) => p.text)
    .join(' ');
}
