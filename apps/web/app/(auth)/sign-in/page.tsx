import Link from 'next/link';

import { AuthForm } from '../../../components/auth-form';
import { Brand } from '../../../components/brand';
import { safeNextPath } from '../../../lib/next-path';
import { signInAction } from '../actions';

export const metadata = { title: 'Sign in' };

/**
 * Sign in. `next` is where a deep link was going; it is validated
 * here and again in the action, so a crafted value can only ever land on `/`.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  return (
    <main id="main" className="auth-page">
      <div className="auth-card">
        <Brand />
        <h1 className="auth-title">Sign in</h1>
        <AuthForm mode="sign-in" next={next} action={signInAction} />
        {/* The read-only login, the one the hosted demo publishes. The owner's
            password is secret on any hosted database (packages/db/src/seed-key.ts);
            locally the README gives it. */}
        <p className="auth-demo">
          Read-only demo: <code translate="no">rui@fieldnote.test</code> /{' '}
          <code translate="no">viewer-password-2026</code>. Create an account to own a workspace.
        </p>
        <p className="auth-switch">
          No account yet? <Link href={`/sign-up?next=${encodeURIComponent(next)}`}>Create one</Link>
        </p>
      </div>
    </main>
  );
}
