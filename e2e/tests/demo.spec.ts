/**
 * The README's demo, captured as frames by `scripts/demo-gif.sh` (DEMO=1 only;
 * playwright.config.ts ignores this file otherwise).
 *
 * The story in seven frames: the hero dashboard, the crosshair reading every
 * lane at one instant, the sentence editor, the same product in another
 * tenant's colours, an unreadable accent refused with the shade that passes,
 * the plan and usage page, and the trace view by night. One viewport each, so
 * the GIF does not jump.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, HERO_DASHBOARD, MAIN_SLUG, SECOND_SLUG, signIn, test } from '../fixtures';

const SHOTS = join(__dirname, '..', 'demo-shots');

test.use({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });

async function frame(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running'),
  );
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function hero(page: Page) {
  await page.goto(`/w/${MAIN_SLUG}`);
  await page.getByRole('link', { name: new RegExp(HERO_DASHBOARD, 'u') }).click();
  await expect(page.getByTestId('lane').first()).toBeVisible();
}

async function crosshair(page: Page, at: number) {
  const plot = page.locator('.lane-plot').first();
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width * at, box.y + box.height / 2);
  await expect(page.getByTestId('readout-head')).not.toHaveText('Whole range');
}

test('demo', async ({ page, browser }) => {
  await signIn(page);
  await hero(page);
  await frame(page, '01-dashboard');

  await crosshair(page, 0.66);
  await frame(page, '02-crosshair');

  await page.getByRole('link', { name: '+ Add lane' }).click();
  await page.getByLabel('Metric').selectOption('unique_users');
  await page.getByLabel('Event').selectOption('page_viewed');
  await page.getByLabel('Break down by').selectOption('device');
  await page.getByRole('button', { name: '+ Filter' }).click();
  await page.getByLabel('Filter property').selectOption('path');
  await page.getByLabel('Filter value').fill('/projects');
  await frame(page, '03-sentence-editor');

  await page.goto(`/w/${SECOND_SLUG}`);
  await page.getByRole('link', { name: /This week/u }).click();
  await expect(page.getByTestId('lane').first()).toBeVisible();
  await crosshair(page, 0.4);
  await frame(page, '04-branded-tenant');

  await page.goto(`/w/${MAIN_SLUG}/settings/branding`);
  await page.getByTestId('accent-hex').fill('#ffd400');
  await expect(page.getByTestId('accent-refusal')).toBeVisible();
  await frame(page, '05-accent-refused');

  await page.goto(`/w/${MAIN_SLUG}/settings/billing`);
  await frame(page, '06-plan-and-usage');

  const night = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
    storageState: await page.context().storageState(),
  });
  const dark = await night.newPage();
  await hero(dark);
  await crosshair(dark, 0.5);
  await frame(dark, '07-night');
  await night.close();
});
