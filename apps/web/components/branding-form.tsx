'use client';

import { accentReport, checkAccent, suggestAccent, type EffectiveBranding } from '@saas/branding';
import { useMemo, useState } from 'react';

import { brandingAction } from '../app/w/actions';
import { ActionForm, Submit } from './action-form';

/**
 * Pick the workspace accent and see, before saving, whether it passes.
 *
 * The check here is the SAME function the API runs (`@saas/branding`), so the
 * preview cannot disagree with the verdict; it is a convenience, and the API
 * is the gate. A failing colour names each failing pair and offers the nearest
 * shade that passes.
 */
export function BrandingForm({
  slug,
  current,
  effective,
}: {
  slug: string;
  current: string | null;
  /** What the stored accent paints as today, re-judged against the current surfaces. */
  effective: EffectiveBranding | null;
}) {
  const [accent, setAccent] = useState(current ?? '#1d5bd6');
  const valid = /^#[0-9a-f]{6}$/u.test(accent.toLowerCase());
  const verdict = useMemo(() => (valid ? checkAccent(accent) : null), [accent, valid]);
  const suggestion = useMemo(
    () => (verdict !== null && !verdict.ok ? suggestAccent(accent) : null),
    [accent, verdict],
  );
  const report = useMemo(
    () => (verdict !== null && !verdict.ok ? accentReport(accent) : null),
    [accent, verdict],
  );

  return (
    <>
      {effective !== null && effective.kind !== 'stored' ? (
        <p className="notice" role="status" data-testid="accent-adjusted">
          <span aria-hidden="true">▲</span>{' '}
          {effective.kind === 'adjusted' ? (
            <>
              Your saved accent <code>{effective.requested}</code> no longer reaches 4.5:1 on the
              product&rsquo;s current backgrounds, so the workspace is showing the nearest shade
              that does, <code>{effective.used}</code>. Save it, or pick another, to make it
              permanent.
            </>
          ) : (
            <>
              Your saved accent <code>{effective.requested}</code> cannot be made readable on the
              current backgrounds, so the workspace is showing the product colour.
            </>
          )}
        </p>
      ) : null}
      <ActionForm
        action={brandingAction}
        hidden={{ workspace: slug }}
        className="panel section"
        label="Workspace accent"
      >
        <div className="inline-form">
          <label className="field">
            <span className="field-label">Accent</span>
            <input
              className="field-input"
              type="color"
              value={valid ? accent : '#000000'}
              onChange={(e) => setAccent(e.target.value)}
              aria-label="Accent colour picker"
            />
          </label>
          <label className="field">
            <span className="field-label">Hex</span>
            <input
              className="field-input mono"
              name="accent"
              value={accent}
              onChange={(e) => setAccent(e.target.value.trim())}
              maxLength={7}
              pattern="#[0-9a-fA-F]{6}"
              required
              data-testid="accent-hex"
            />
          </label>
        </div>

        {verdict === null ? (
          <p className="field-hint">Enter a colour like #1d5bd6.</p>
        ) : verdict.ok ? (
          <div className="swatches" aria-label="How it will look">
            {(['light', 'dark'] as const).map((scheme) => (
              <div className="swatch" key={scheme}>
                <span className="swatch-chip" style={{ background: verdict[scheme].accent }} />
                <span>
                  {scheme}: <code>{verdict[scheme].accent}</code>
                </span>
                <span
                  className="button button-small"
                  style={{
                    background: verdict[scheme].accent,
                    color: verdict[scheme].ink,
                    borderColor: verdict[scheme].accent,
                  }}
                >
                  Button
                </span>
              </div>
            ))}
            <p className="status-word" data-state="ok" role="status">
              ✓ Passes WCAG AA on every surface, in both schemes
            </p>
          </div>
        ) : (
          <div className="accent-refusal" role="status" data-testid="accent-refusal">
            <p className="form-error">
              <span aria-hidden="true">⚠</span>
              <span>Not readable everywhere it would be painted. The failing surfaces:</span>
            </p>
            {report === null ? null : (
              <table className="table pair-table">
                <caption className="visually-hidden">Contrast of {accent} on each surface</caption>
                <thead>
                  <tr>
                    <th scope="col">Where</th>
                    <th scope="col">Pair</th>
                    <th scope="col" className="num">
                      Ratio
                    </th>
                    <th scope="col">Needs 4.5:1</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr key={row.where} data-pass={row.pass}>
                      <th scope="row">{row.where}</th>
                      <td>
                        {/* Two colours, no text: a failing pair set as text would
                            itself be an unreadable string on the page. */}
                        <span
                          className="pair-sample"
                          style={{ background: row.background }}
                          aria-hidden="true"
                        >
                          <span style={{ background: row.foreground }} />
                        </span>{' '}
                        <code>{row.foreground}</code> on <code>{row.background}</code>
                      </td>
                      <td className="num">{row.ratio.toFixed(2)}:1</td>
                      <td className="status-word" data-state={row.pass ? 'ok' : 'danger'}>
                        {row.pass ? '✓ Passes' : '✕ Fails'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {report !== null && report.darkShade === null ? (
              <p className="field-hint">
                ✕ No lighter shade of this hue reaches 4.5:1 on the dark backgrounds.
              </p>
            ) : null}
            {suggestion !== null ? (
              <p className="inline-form">
                <span>The nearest shade that passes everywhere:</span>
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => setAccent(suggestion)}
                >
                  <span
                    className="swatch-chip"
                    style={{ background: suggestion }}
                    aria-hidden="true"
                  />
                  Use {suggestion}
                </button>
              </p>
            ) : null}
          </div>
        )}

        <div className="inline-form">
          <Submit pendingText="Saving">Save accent</Submit>
          {current !== null ? (
            // The control is "intent", never "reset": a control called reset replaces form.reset(), which
            // React calls after every successful action ("n.reset is not a function").
            <Submit className="button" name="intent" value="reset" pendingText="Resetting">
              Reset to product colour
            </Submit>
          ) : null}
        </div>
      </ActionForm>
    </>
  );
}
