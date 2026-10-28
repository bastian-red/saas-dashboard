/**
 * The redesign's promises that only a browser can check (docs/DESIGN.md):
 * the roll call answers before any chart is read, lane removal takes a
 * deliberate second step, number figures never sit on their line, the axis
 * labels calendar boundaries once each, and no page scrolls sideways on a phone.
 */
import type { Page } from '@playwright/test';

import { expect, HERO_DASHBOARD, MAIN_SLUG, signIn, test } from '../fixtures';

async function openHero(page: Page) {
  await signIn(page);
  await page.getByRole('link', { name: new RegExp(HERO_DASHBOARD, 'u') }).click();
  await expect(page.getByRole('heading', { name: HERO_DASHBOARD })).toBeVisible();
}

test('the roll call names what moved, in words, and each entry jumps to its lane', async ({
  page,
}) => {
  await openHero(page);
  const roll = page.getByTestId('rollcall');
  await expect(roll).toBeVisible();
  // The seed's synthetic sign-up surge (packages/db/prisma/seed.mts) is called Up.
  const surge = roll.locator('.rollcall-entry', { hasText: 'Sign-ups by source' });
  await expect(surge.locator('.verdict')).toHaveText(/^▲ Up \+\d+%$/u);
  await expect(roll.locator('.rollcall-summary')).toContainText(/lanes? moved/u);

  // Every lane is in the roll call, each with a verdict word, never a colour alone.
  const lanes = await page.getByTestId('lane').count();
  await expect(roll.locator('.rollcall-entry')).toHaveCount(lanes);
  for (const word of await roll.locator('.verdict').allTextContents()) {
    expect(word).toMatch(/Up|Down|Steady|No baseline/u);
  }

  // The lane says the same, with the numbers the verdict came from.
  await surge.click();
  const lane = page.getByTestId('lane').filter({ hasText: 'Sign-ups by source' });
  await expect(page).toHaveURL(/#row-/u);
  await expect(lane.getByTestId('lane-verdict')).toContainText(
    /against a typical \d+; steady from/u,
  );
});

test('the 24-hour range has no baseline and says so instead of guessing', async ({ page }) => {
  await openHero(page);
  await page.getByRole('button', { name: '24 hours' }).click();
  await expect(page.getByTestId('rollcall').locator('.verdict').first()).toHaveText(/No baseline/u);
});

test('removing a lane takes a second, worded step, and Keep it backs out', async ({ page }) => {
  await openHero(page);
  const lane = page.getByTestId('lane').first();
  const title = (await lane.locator('.lane-title').innerText()).trim();
  await expect(lane.getByRole('button', { name: `Remove ${title}`, exact: true })).toHaveCount(0);
  await lane.getByText('More', { exact: true }).click();
  await lane.getByRole('button', { name: `Remove ${title}…` }).click();
  await expect(
    lane.getByText(new RegExp(`Remove ${title} from this dashboard\\?`, 'u')),
  ).toBeVisible();
  await lane.getByRole('button', { name: 'Keep it' }).click();
  await expect(lane.getByRole('button', { name: `Remove ${title}`, exact: true })).toHaveCount(0);
  await expect(page.getByTestId('lane').first().locator('.lane-title')).toHaveText(title);
});

test('a number lane keeps its figure off its line', async ({ page }) => {
  await openHero(page);
  const figure = page.getByTestId('lane-figure').first();
  const spark = page.getByTestId('number-spark').first();
  const a = (await figure.boundingBox())!;
  const b = (await spark.boundingBox())!;
  const overlap =
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  expect(overlap, `figure ${JSON.stringify(a)} overlaps line ${JSON.stringify(b)}`).toBe(false);
});

test('the axis labels each calendar boundary once, and never repeats the cursor date at the edge', async ({
  page,
}) => {
  await openHero(page);
  for (const range of ['7 days', '30 days']) {
    await page.getByRole('button', { name: range }).click();
    await expect(page.getByRole('button', { name: range })).toHaveAttribute('aria-pressed', 'true');
    const labels = await page.getByTestId('axis-tick').allInnerTexts();
    expect(labels.length).toBeGreaterThan(3);
    expect(new Set(labels).size, labels.join(', ')).toBe(labels.length);
    if (range === '7 days') for (const l of labels) expect(l).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/u);
  }
  await expect(page.getByTestId('readout-head')).toHaveText('Whole range');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('no page scrolls sideways', async ({ page }) => {
    await signIn(page);
    const paths = [
      `/w/${MAIN_SLUG}`,
      `/w/${MAIN_SLUG}/settings/members`,
      `/w/${MAIN_SLUG}/settings/keys`,
      `/w/${MAIN_SLUG}/settings/billing`,
      `/w/${MAIN_SLUG}/settings/branding`,
      '/w/new',
      '/status',
    ];
    for (const path of paths) {
      await page.goto(path);
      const { scroll, client } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(
        scroll,
        `${path} is ${String(scroll - client)}px wider than the screen`,
      ).toBeLessThanOrEqual(client);
    }
    await page.goto(`/w/${MAIN_SLUG}`);
    await page.getByRole('link', { name: new RegExp(HERO_DASHBOARD, 'u') }).click();
    await expect(page.getByTestId('rollcall')).toBeVisible();
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(scroll).toBeLessThanOrEqual(client);
  });
});
