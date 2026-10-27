import { ActionForm, Submit } from '../../../components/action-form';
import { Brand } from '../../../components/brand';
import { requireUser } from '../../../lib/session';
import { acceptInviteAction } from '../../w/actions';

export const metadata = { title: 'Join a workspace' };

/**
 * An invite link. Signing in comes first (and comes back here); accepting is
 * a deliberate click, so a link opened by a mail scanner's prefetch joins
 * nobody. The API checks the token, its expiry, and that it was sent to the
 * address of the account accepting it.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await requireUser(`/invite/${encodeURIComponent(token)}`);
  return (
    <main id="main" className="auth-page">
      <div className="auth-card">
        <Brand />
        <h1 className="auth-title">Join a workspace</h1>
        <p className="muted">
          You are signed in as <strong>{user.email}</strong>. The invite must have been sent to this
          address.
        </p>
        <ActionForm action={acceptInviteAction} hidden={{ token }} className="auth-form">
          <Submit pendingText="Joining">Accept invite</Submit>
        </ActionForm>
      </div>
    </main>
  );
}
