import Link from 'next/link';

import { Brand } from '../components/brand';

/**
 * One answer for "does not exist" and "not yours". A workspace you are not a
 * member of is indistinguishable from one that does not exist, by design.
 */
export default function NotFound() {
  return (
    <main id="main" className="auth-page">
      <div className="auth-card">
        <Brand />
        <h1 className="auth-title">Nothing here</h1>
        <p className="muted">
          That page does not exist, or it belongs to a workspace you are not a member of.
        </p>
        <Link className="button" href="/">
          Back to your workspaces
        </Link>
      </div>
    </main>
  );
}
