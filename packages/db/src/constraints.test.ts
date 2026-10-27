import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as constraints from './constraints';

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const statements = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => readFileSync(join(MIGRATIONS, e.name, 'migration.sql'), 'utf8'))
  .join('\n')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

const named = Object.entries(constraints)
  .filter(([key, value]) => typeof value === 'string' && /^[A-Z_]+$/u.test(key))
  .filter(([key]) => !key.startsWith('PRISMA_') && !key.startsWith('PG_'));

describe('every exported constraint name exists in a migration', () => {
  it('has a non-trivial number of them', () => {
    expect(named.length).toBeGreaterThanOrEqual(6);
  });
  for (const [key, value] of named) {
    it(`${key} -> ${String(value)}`, () => {
      expect(statements).toContain(`"${String(value)}"`);
    });
  }
});
