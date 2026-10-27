import { laneSpecSchema } from '@saas/shared';
import { describe, expect, it } from 'vitest';

import { sentence, sentenceText } from './sentence';

const spec = (s: Record<string, unknown>) => laneSpecSchema.parse(s);

describe('a lane reads as a sentence', () => {
  it('unique users, broken down', () => {
    expect(
      sentenceText(
        spec({ metric: 'unique_users', event: 'page_viewed', breakdown: 'device', viz: 'stacked' }),
      ),
    ).toBe('Unique users who did page_viewed by device as stacked columns');
  });

  it('a sum names its property before the event', () => {
    expect(
      sentenceText(
        spec({ metric: 'sum', event: 'checkout_completed', sumProperty: 'amount', viz: 'number' }),
      ),
    ).toBe('Sum of amount on checkout_completed as a number');
  });

  it('filters read as words, not operators', () => {
    const s = spec({
      metric: 'count',
      event: 'checkout_completed',
      filters: [{ property: 'plan', op: 'neq', value: 'team' }],
    });
    expect(sentenceText(s)).toBe('Count of checkout_completed where plan is not team as a line');
  });

  it('every field the editor can change is a token, and only those', () => {
    const pieces = sentence(
      spec({ metric: 'count', event: 'signed_up', breakdown: 'source', viz: 'stacked' }),
    );
    expect(
      pieces.filter((p) => p.kind === 'token').map((p) => (p.kind === 'token' ? p.field : null)),
    ).toEqual(['metric', 'event', 'breakdown', 'viz']);
  });
});
