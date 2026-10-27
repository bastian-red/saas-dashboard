'use client';

import { useActionState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

import { IDLE, type FormState } from '../lib/form-state';

type Action = (previous: FormState, form: FormData) => Promise<FormState>;

/**
 * A server action form that works before JavaScript loads (a plain POST) and,
 * after it does, renders the action's answer in place: an error as
 * `role="alert"`, a notice as `role="status"`, a one-time secret in a
 * read-only field a person can select and copy.
 */
export function ActionForm({
  action,
  children,
  className,
  hidden = {},
  label,
}: {
  readonly action: Action;
  readonly children: ReactNode;
  readonly className?: string;
  /** Hidden fields: the workspace, the dashboard, the lane. */
  readonly hidden?: Record<string, string>;
  /** The form's accessible name, when it has no visible heading of its own. */
  readonly label?: string;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  return (
    <form className={className} action={formAction} aria-label={label}>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      {state.error ? (
        <p className="form-error" role="alert">
          <span aria-hidden="true">⚠</span>
          <span>{state.error}</span>
        </p>
      ) : null}
      {state.notice ? (
        <p className="form-ok" role="status">
          <span aria-hidden="true">✓</span>
          <span>{state.notice}</span>
        </p>
      ) : null}
      {state.secret ? (
        <div className="key-reveal">
          <label className="field">
            <span className="field-label">Shown once</span>
            <input
              className="field-input mono"
              readOnly
              value={state.secret}
              onFocus={(e) => e.currentTarget.select()}
              data-testid="secret"
            />
          </label>
        </div>
      ) : null}
    </form>
  );
}

/** A submit button that says what it is doing while the action runs. */
export function Submit({
  children,
  pendingText,
  className = 'button button-primary',
  name,
  value,
}: {
  readonly children: ReactNode;
  readonly pendingText?: string;
  readonly className?: string;
  readonly name?: string;
  readonly value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      className={className}
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      name={name}
      value={value}
    >
      {pending && pendingText ? pendingText : children}
    </button>
  );
}
