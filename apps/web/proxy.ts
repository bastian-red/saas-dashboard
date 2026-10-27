import { NextResponse, type NextRequest } from 'next/server';

import { signInRedirect } from './lib/sign-in-gate';

/**
 * Next 16's request proxy (formerly middleware): sends a signed-out request
 * for a workspace page to sign-in with its full path. lib/sign-in-gate.ts
 * says why this cannot live in the layout.
 */
export function proxy(request: NextRequest) {
  const target = signInRedirect(
    request.nextUrl.pathname,
    request.nextUrl.search,
    request.cookies.getAll().map((c) => c.name),
  );
  return target === null
    ? NextResponse.next()
    : NextResponse.redirect(new URL(target, request.url));
}

export const config = { matcher: ['/w/:path*', '/invite/:path*', '/billing/:path*'] };
