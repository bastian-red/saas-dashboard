/**
 * The aggregator reads events up to "now minus SAFE_LAG_MS" and then never
 * looks behind its watermark again. That is exactly-once only if no ingest
 * transaction can still be open, about to commit rows with an older
 * ingested_at, when the window closes. Ingest bounds every write transaction
 * with WRITE_TIMEOUT_MS (statement and idle-in-transaction timeouts). If the
 * lag ever shrank to the timeout, or the timeout grew past the lag, a slow
 * commit would land behind the watermark and those events would never be
 * counted, with every other test still green.
 */
import { WRITE_TIMEOUT_MS } from '@saas/ingest';
import { describe, expect, it } from 'vitest';

import { SAFE_LAG_MS } from './aggregate';

describe('the aggregation window and the ingest write bound', () => {
  it('the safe lag exceeds the longest a write transaction can stay open, with margin', () => {
    // A transaction is bounded by one statement timeout plus one idle timeout
    // in the worst case; require the lag to clear both together.
    expect(SAFE_LAG_MS).toBeGreaterThan(2 * WRITE_TIMEOUT_MS);
  });
});
