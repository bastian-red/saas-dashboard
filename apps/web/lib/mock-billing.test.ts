import { describe, expect, it } from 'vitest';

import { slugFromReturnUrl } from './mock-billing';

const APP = 'http://localhost:3000';

describe('the mock checkout reads its workspace from the return URL', () => {
  it('accepts the URL the API builds', () => {
    expect(slugFromReturnUrl(`${APP}/w/fieldnote/settings/billing?checkout=success`, APP)).toBe(
      'fieldnote',
    );
  });

  it.each([
    ['missing', undefined],
    ['not a URL', 'nope'],
    ['another origin', 'https://evil.example/w/fieldnote/settings/billing'],
    ['another route', `${APP}/w/fieldnote/settings/members`],
    ['a traversal', `${APP}/w/fieldnote/../x/settings/billing`],
    ['a bad slug', `${APP}/w/Fieldnote/settings/billing`],
  ])('refuses %s', (_label, raw) => {
    expect(slugFromReturnUrl(raw, APP)).toBeNull();
  });
});
