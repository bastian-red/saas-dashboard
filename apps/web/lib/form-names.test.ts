/**
 * No form control is named after a property of HTMLFormElement.
 *
 * A control named "reset" REPLACES `form.reset` with itself (DOM named
 * property access), and React 19 calls `form.reset()` after every successful
 * server action: the branding page threw "n.reset is not a function" on every
 * save until the E2E page-error gate caught it. "submit", "action", "method",
 * "elements" and friends break the same way.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const WEB = join(__dirname, '..');
const CLOBBERING = [
  'reset',
  'submit',
  'action',
  'method',
  'elements',
  'length',
  'target',
  'encoding',
  'requestSubmit',
];

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx$/u.test(path) ? [path] : [];
  });
}

describe('form control names', () => {
  it('never shadow a form method or property', () => {
    const files = ['app', 'components'].flatMap((dir) => walk(join(WEB, dir)));
    expect(files.length).toBeGreaterThan(15);
    const offenders: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\bname=["']([A-Za-z]+)["']/gu)) {
        if (CLOBBERING.includes(m[1]!))
          offenders.push(`${file.slice(WEB.length + 1)}: name="${m[1]!}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
