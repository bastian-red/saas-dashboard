'use client';

import { useId, useState } from 'react';

import type { FormState } from '../lib/form-state';
import { ActionForm, Submit } from './action-form';

type Action = (previous: FormState, form: FormData) => Promise<FormState>;

/**
 * Leaving a workspace, in two worded steps. Leaving is not undoable from this
 * side: only someone who can invite can let you back in. So the first button
 * only asks, the second says what is lost, and "Stay" backs out, the same shape
 * as removing a lane (`trace.tsx`).
 */
export function LeaveWorkspace({
  action,
  hidden,
  workspaceName,
}: {
  readonly action: Action;
  readonly hidden: Record<string, string>;
  readonly workspaceName: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const textId = useId();

  if (!confirming) {
    return (
      <button className="button" type="button" onClick={() => setConfirming(true)}>
        Leave {workspaceName}…
      </button>
    );
  }
  return (
    <ActionForm action={action} hidden={hidden} className="panel" label="Leave workspace">
      <p id={textId}>
        Leave <strong>{workspaceName}</strong>? You lose access to its dashboards at once, and only
        someone who can invite can bring you back.
      </p>
      <div className="inline-form">
        <Submit className="button button-danger-solid" pendingText="Leaving…">
          Leave workspace
        </Submit>
        <button className="button" type="button" onClick={() => setConfirming(false)}>
          Stay
        </button>
      </div>
    </ActionForm>
  );
}
