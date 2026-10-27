/**
 * Where a signed-out request for a protected page is sent: sign-in, with the
 * WHOLE path and query as `next`.
 *
 * Why this lives in the proxy and not in a layout: the workspace layout runs
 * before its page and does not know the URL it is rendering, so a redirect
 * from there could only say `next=/w/<slug>`, and a deep link to members or a
 * lane being edited came back to the dashboards list. The E2E suite caught it.
 *
 * Cookie PRESENCE only. Verifying the session is the pages' job (and the
 * API's, on every call); this only decides where a request with no session at
 * all should go first. A forged cookie gets past this and is then refused by
 * `auth()`, which redirects with the shorter `next`, which is fine.
 */
export const SESSION_COOKIES = ['authjs.session-token', '__Secure-authjs.session-token'] as const;

const PROTECTED = /^\/(w|invite|billing)(\/|$)/u;

export function signInRedirect(
  pathname: string,
  search: string,
  cookieNames: readonly string[],
): string | null {
  if (!PROTECTED.test(pathname)) return null;
  // Auth.js splits a large session into chunks: authjs.session-token.0, .1, ...
  const signedIn = cookieNames.some((name) =>
    SESSION_COOKIES.some((c) => name === c || name.startsWith(`${c}.`)),
  );
  if (signedIn) return null;
  return `/sign-in?next=${encodeURIComponent(`${pathname}${search}`)}`;
}
