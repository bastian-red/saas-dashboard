import { describe, expect, it } from 'vitest';

import { signInRedirect } from './sign-in-gate';

describe('the signed-out deep link', () => {
  it('keeps the whole path and query', () => {
    expect(signInRedirect('/w/fieldnote/d/cdash000000000000000000000', '?edit=new', [])).toBe(
      '/sign-in?next=%2Fw%2Ffieldnote%2Fd%2Fcdash000000000000000000000%3Fedit%3Dnew',
    );
    expect(signInRedirect('/invite/abc', '', ['other'])).toBe('/sign-in?next=%2Finvite%2Fabc');
  });

  it('lets a request with a session (or a chunked one) through', () => {
    expect(signInRedirect('/w/fieldnote', '', ['authjs.session-token'])).toBeNull();
    expect(signInRedirect('/w/fieldnote', '', ['__Secure-authjs.session-token.0'])).toBeNull();
  });

  it('leaves public pages alone', () => {
    for (const path of ['/sign-in', '/sign-up', '/status', '/api/auth/session', '/', '/works']) {
      expect(signInRedirect(path, '', []), path).toBeNull();
    }
  });
});
