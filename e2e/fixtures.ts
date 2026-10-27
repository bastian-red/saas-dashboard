/**
 * Shared E2E helpers.
 *
 * The seeded facts are read out of `packages/db/prisma/seed.mts` rather than
 * retyped, so a renamed seed workspace fails here with a sentence instead of
 * every spec failing with "element not found".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';

const SEED = readFileSync(join(__dirname, '..', 'packages', 'db', 'prisma', 'seed.mts'), 'utf8');

function seedConst(name: string): string {
  const match = new RegExp(`^const ${name} = '([^']*)';`, 'm').exec(SEED);
  if (!match) throw new Error(`Could not read ${name} out of packages/db/prisma/seed.mts.`);
  return match[1]!;
}

export const DEMO_EMAIL = seedConst('DEMO_EMAIL');
export const DEMO_PASSWORD = seedConst('DEMO_PASSWORD');
export const VIEWER_EMAIL = seedConst('VIEWER_EMAIL');
export const VIEWER_PASSWORD = seedConst('VIEWER_PASSWORD');
export const OUTSIDER_EMAIL = seedConst('OUTSIDER_EMAIL');
export const OUTSIDER_PASSWORD = seedConst('OUTSIDER_PASSWORD');
export const MAIN_SLUG = seedConst('MAIN_SLUG');
export const MAIN_NAME = seedConst('MAIN_NAME');
export const SECOND_SLUG = seedConst('SECOND_SLUG');
export const SECOND_ACCENT = seedConst('SECOND_ACCENT');
export const HERO_DASHBOARD = seedConst('HERO_DASHBOARD');

export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
export const INGEST_URL = process.env.INGEST_INTERNAL_URL ?? 'http://localhost:4200';
export const AGGREGATOR_URL = process.env.AGGREGATOR_INTERNAL_URL ?? 'http://localhost:4300';

export function randomAddress(): string {
  const octet = () => String(1 + Math.floor(Math.random() * 254));
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** `#rrggbb` as the `rgb(r, g, b)` getComputedStyle reports. */
export function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${String((n >> 16) & 255)}, ${String((n >> 8) & 255)}, ${String(n & 255)})`;
}

export async function signIn(
  page: Page,
  email = DEMO_EMAIL,
  password = DEMO_PASSWORD,
  next?: string,
) {
  await page.goto(next === undefined ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Wait for the END of the redirect chain (sign-in -> / -> /w/<slug>), not its
  // first hop: navigating mid-chain aborts it (Firefox: NS_BINDING_ABORTED).
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in') && url.pathname !== '/');
  await page.waitForLoadState('load');
}

/** Sign out and wait until the sign-in page has finished loading. */
export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/sign-in/u);
  await page.waitForLoadState('load');
}

/**
 * A form's own error. Not getByRole('alert'): Next's route announcer is an
 * alert too, so that query matches two elements on every page.
 */
// role="alert" only: the branding page's live preview is a .form-error too,
// but a role="status" one; the alert is the server action's answer.
export const formError = (page: Page) => page.locator('.form-error[role="alert"]');

/** A new account with no workspace: sign-up lands on "New workspace". */
export async function signUpFresh(page: Page, label: string): Promise<string> {
  const email = `${label}-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}@saas.test`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(label);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('a-long-enough-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL((url) => url.pathname === '/w/new');
  return email;
}

/** A workspace of its own, so a spec that changes things never shares state with another. */
export async function createWorkspace(page: Page, name: string): Promise<string> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}-${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 100))}`;
  await page.goto('/w/new');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Address').fill(slug);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.waitForURL(`**/w/${slug}`);
  return slug;
}

/** Create an API key on the keys page and read it from the one-time reveal. */
export async function createKey(page: Page, slug: string, name = 'e2e'): Promise<string> {
  await page.goto(`/w/${slug}/settings/keys`);
  await page.getByLabel('New key name').fill(name);
  await page.getByRole('button', { name: 'Create key' }).click();
  const secret = page.getByTestId('secret');
  await expect(secret).toHaveValue(/^sk_/u);
  return secret.inputValue();
}

/** POST a batch to the ingest service, as a customer's backend would. */
export async function sendEvents(request: APIRequestContext, key: string, events: unknown[]) {
  const response = await request.post(`${INGEST_URL}/v1/events`, {
    headers: { authorization: `Bearer ${key}` },
    data: { events },
  });
  return response;
}

/**
 * Every spec fails on an uncaught error in the page, and every spec's browser
 * comes from its own address.
 *
 * The address: the web server forwards the browser's X-Forwarded-For to the
 * API, which keys its sign-in budget (5 a minute, the documented value) on it.
 * One shared address would make the sixth sign-in of the run a 429; a lifted
 * budget would hide real limiter bugs. A fresh address per test is how many
 * real people look.
 */
export const test = base.extend<{ failOnPageError: void }>({
  // Playwright reads a fixture's dependencies from the first parameter's
  // destructuring pattern, so an empty one is its documented form.
  // eslint-disable-next-line no-empty-pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'x-forwarded-for': randomAddress() });
  },
  failOnPageError: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await use();
      expect(errors, 'uncaught errors in the page').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };
