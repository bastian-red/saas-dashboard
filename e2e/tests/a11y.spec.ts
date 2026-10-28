/**
 * axe over every route, in both colour schemes, zero violations. Includes a
 * BRANDED workspace (the tenant's accent on the rail and buttons), the open
 * sentence editor, the crosshair engaged, and a refused accent on screen.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';

import { expect, HERO_DASHBOARD, MAIN_SLUG, SECOND_SLUG, signIn, test } from '../fixtures';

const SCHEMES = ['light', 'dark'] as const;
const RECORDING = process.env.BASELINE === '1';

async function scan(page: Page, testInfo: TestInfo, route: string, scheme: string) {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  if (RECORDING) {
    await testInfo.attach('a11y', {
      contentType: 'application/json',
      body: JSON.stringify({ route, scheme, violations: results.violations }),
    });
    return;
  }
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}

async function hero(page: Page) {
  await page.goto(`/w/${MAIN_SLUG}`);
  await page.getByRole('link', { name: new RegExp(HERO_DASHBOARD, 'u') }).click();
  await expect(page.getByTestId('lane').first()).toBeVisible();
}

for (const scheme of SCHEMES) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('sign in and sign up', async ({ page }, testInfo) => {
      await page.goto('/sign-in');
      await scan(page, testInfo, '/sign-in', scheme);
      await page.goto('/sign-up');
      await scan(page, testInfo, '/sign-up', scheme);
    });

    test('status', async ({ page }, testInfo) => {
      await page.goto('/status');
      await scan(page, testInfo, '/status', scheme);
    });

    test('dashboard, crosshair engaged and a table open', async ({ page }, testInfo) => {
      await signIn(page);
      await hero(page);
      await page.getByRole('slider', { name: /Time cursor/u }).focus();
      await page.keyboard.press('ArrowLeft');
      await page.getByTestId('lane').first().getByText('Table of values').click();
      await scan(page, testInfo, '/w/:slug/d/:id', scheme);
    });

    test('sentence editor open', async ({ page }, testInfo) => {
      await signIn(page);
      await hero(page);
      await page.getByRole('link', { name: '+ Add lane' }).click();
      await expect(page.getByLabel('Metric')).toBeVisible();
      await scan(page, testInfo, '/w/:slug/d/:id?edit=new', scheme);
    });

    test('a branded workspace, switcher open', async ({ page }, testInfo) => {
      await signIn(page);
      await page.goto(`/w/${SECOND_SLUG}`);
      await page.getByRole('link', { name: /This week/u }).click();
      await expect(page.getByTestId('lane').first()).toBeVisible();
      await page.locator('.switcher summary').click();
      await scan(page, testInfo, '/w/:branded/d/:id', scheme);
    });

    test('settings: dashboards, members, keys, billing', async ({ page }, testInfo) => {
      await signIn(page);
      for (const path of ['', '/settings/members', '/settings/keys', '/settings/billing']) {
        await page.goto(`/w/${MAIN_SLUG}${path}`);
        await scan(page, testInfo, `/w/:slug${path}`, scheme);
      }
    });

    test('branding, with a refused colour on screen', async ({ page }, testInfo) => {
      await signIn(page);
      await page.goto(`/w/${MAIN_SLUG}/settings/branding`);
      await page.getByTestId('accent-hex').fill('#ffd400');
      await expect(page.getByTestId('accent-refusal')).toBeVisible();
      await scan(page, testInfo, '/w/:slug/settings/branding', scheme);
    });

    test('not found', async ({ page }, testInfo) => {
      await signIn(page);
      await page.goto('/w/no-such-workspace');
      await scan(page, testInfo, '404', scheme);
    });
  });
}
