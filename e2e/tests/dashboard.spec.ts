/**
 * The trace view: lanes on one axis, one crosshair through all of them, a
 * table behind every lane.
 */
import { expect, HERO_DASHBOARD, signIn, test } from '../fixtures';

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: new RegExp(HERO_DASHBOARD, 'u') }).click();
  await expect(page.getByRole('heading', { name: HERO_DASHBOARD })).toBeVisible();
});

test('every seeded lane renders real numbers', async ({ page }) => {
  const lanes = page.getByTestId('lane');
  await expect(lanes).toHaveCount(6);
  await expect(page.getByRole('heading', { name: 'Active users', exact: true })).toBeVisible();
  // Whole-range readouts: the seeded month is not empty, so no lane says 0.
  const values = await page.getByTestId('readout-value').allInnerTexts();
  expect(values.length).toBeGreaterThanOrEqual(6);
  for (const v of values) expect(v).not.toBe('0');
  // A unique-users estimate always states its error.
  await expect(lanes.first()).toContainText('±2.3%');
});

test('the keyboard moves one crosshair through every lane', async ({ page }) => {
  const head = page.getByTestId('readout-head');
  await expect(head).toHaveText('Whole range');
  const axis = page.getByRole('slider', { name: /Time cursor/u });
  await axis.focus();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await expect(head).not.toHaveText('Whole range');
  const label = await head.innerText();
  expect(await axis.getAttribute('aria-valuetext')).toContain(label);
  // Every plot draws the line at the same instant.
  await expect(page.locator('.plot-crosshair')).toHaveCount(5); // the table lane has no plot
  const xs = await page
    .locator('.plot-crosshair')
    .evaluateAll((lines) => lines.map((l) => l.getAttribute('x1')));
  expect(new Set(xs).size).toBe(1);
  // And every single-series readout switches to the bucket.
  await expect(page.getByText('In bucket').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(head).toHaveText('Whole range');
});

test('pointing at any lane reads every lane at that instant', async ({ page }) => {
  const plot = page.locator('.lane-plot').nth(1);
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await expect(page.getByTestId('readout-head')).not.toHaveText('Whole range');
  // toHaveCount, not toBeVisible: a vertical SVG line has zero width, which
  // Playwright reports as hidden.
  await expect(page.locator('.plot-crosshair')).toHaveCount(5);
});

test('every lane has its numbers as a table', async ({ page }) => {
  const lane = page.getByTestId('lane').first();
  await lane.getByText('Table of values').click();
  // One row per bucket of the shared axis. Thirty days of day buckets in the
  // viewer's zone is 31 buckets (a partial day at each end), so the count is
  // read off the axis rather than assumed.
  const buckets =
    Number(await page.getByRole('slider', { name: /Time cursor/u }).getAttribute('aria-valuemax')) +
    1;
  expect(buckets).toBeGreaterThanOrEqual(30);
  await expect(lane.locator('.lane-data tbody tr')).toHaveCount(buckets);
});
