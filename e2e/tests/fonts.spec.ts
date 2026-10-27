/**
 * The three self-hosted faces actually load and paint.
 *
 * A missing or mis-pathed woff2 does not fail a build or a page: the browser
 * silently falls back to the system sans, every other test stays green, and
 * the identity quietly becomes "whatever the machine has". This asserts the
 * fonts the browser loaded, and that headings, chrome and code use different
 * loaded faces.
 */
import { expect, MAIN_SLUG, signIn, test } from '../fixtures';

test('display, UI and mono faces are loaded and in use', async ({ page }) => {
  await signIn(page);
  // The keys page has all three: a heading, chrome, and the curl snippet in code.
  await page.goto(`/w/${MAIN_SLUG}/settings/keys`);
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() =>
    [...document.fonts]
      .filter((f) => f.status === 'loaded')
      .map((f) => f.family.replace(/['"]/gu, '')),
  );
  expect(new Set(loaded).size, `loaded faces: ${loaded.join(', ')}`).toBeGreaterThanOrEqual(3);

  const first = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) =>
        getComputedStyle(el).fontFamily.split(',')[0]!.replace(/['"]/gu, '').trim(),
      );
  const heading = await first('h1');
  const chrome = await first('body');
  const code = await first('code.snippet');
  for (const family of [heading, chrome, code]) expect(loaded, family).toContain(family);
  expect(new Set([heading, chrome, code]).size).toBe(3);
});
