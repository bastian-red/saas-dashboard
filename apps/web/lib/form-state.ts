/**
 * What every server action hands back to its form. `error` renders as an
 * alert beside the form; `notice` as a confirmation; `secret` is shown once
 * (a new API key, an invite link) and never stored by this app.
 */
export interface FormState {
  readonly error: string | null;
  readonly notice?: string | null;
  readonly secret?: string | null;
}

export const IDLE: FormState = { error: null };
