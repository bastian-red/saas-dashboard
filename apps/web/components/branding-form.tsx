'use client';

import { checkAccent, suggestAccent } from '@saas/branding';
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
export function BrandingForm({ slug, current }: { slug: string; current: string | null }) {
  const [accent, setAccent] = useState(current ?? '#1d5bd6');
  const valid = /^#[0-9a-f]{6}$/u.test(accent.toLowerCase());
  const verdict = useMemo(() => (valid ? checkAccent(accent) : null), [accent, valid]);
  const suggestion = useMemo(
    () => (verdict !== null && !verdict.ok ? suggestAccent(accent) : null),
    [accent, verdict],
  );

  return (
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
        <div className="form-error" role="status">
          <span aria-hidden="true">⚠</span>
          <span>
            Would not be readable everywhere: {verdict.issues.join('; ')}.
            {suggestion !== null ? (
              <>
                {' '}
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => setAccent(suggestion)}
                >
                  Use {suggestion}
                </button>
              </>
            ) : null}
          </span>
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
  );
}
