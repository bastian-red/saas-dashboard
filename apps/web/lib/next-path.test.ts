import { describe, expect, it } from 'vitest';

import { DEFAULT_AFTER_SIGN_IN, safeNextPath } from './next-path';

describe('safeNextPath keeps a reader on this origin', () => {
  it('returns a same-origin path with its query intact, which is the deep-link case', () => {
    expect(safeNextPath('/w/fieldnote/d/cdashfieldnote00000000000?lane=2')).toBe(
      '/w/fieldnote/d/cdashfieldnote00000000000?lane=2',
    );
  });

  it.each([
    ['protocol-relative', '//evil.example/x'],
    ['backslash that browsers normalise to //', '/\\evil.example'],
    ['absolute https', 'https://evil.example'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['relative without a leading slash', 'd/abc'],
    ['a header-splitting newline', '/w/abc\r\nSet-Cookie: x=1'],
    ['a tab, which URL parsing strips silently', '/\t/evil.example'],
    ['empty', ''],
  ])('refuses %s', (_name, raw) => {
    expect(safeNextPath(raw)).toBe(DEFAULT_AFTER_SIGN_IN);
  });

  it('falls back when there is no value at all', () => {
    expect(safeNextPath(null)).toBe(DEFAULT_AFTER_SIGN_IN);
    expect(safeNextPath(undefined)).toBe(DEFAULT_AFTER_SIGN_IN);
  });

  it('normalises dot segments rather than passing them through', () => {
    expect(safeNextPath('/w/../status')).toBe('/status');
  });
});
