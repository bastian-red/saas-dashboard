/**
 * A workspace accent: refused when it would be unreadable, accepted shade
 * offered, applied to the marks it was judged for (and only those), in both
 * schemes.
 */
import {
  createWorkspace,
  expect,
  formError,
  rgb,
  SECOND_ACCENT,
  SECOND_SLUG,
  signIn,
  signUpFresh,
  test,
} from '../fixtures';

test('the seeded branded workspace wears its accent on the rail and buttons only', async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/w/${SECOND_SLUG}`);
  await expect(page.locator('.ws-mark')).toHaveCSS('background-color', rgb(SECOND_ACCENT));
  await expect(page.getByRole('button', { name: 'Create' })).toHaveCSS(
    'background-color',
    rgb(SECOND_ACCENT),
  );
  // Body text keeps the product ink.
  await expect(page.getByRole('heading', { name: 'Dashboards' })).not.toHaveCSS(
    'color',
    rgb(SECOND_ACCENT),
  );
});

test.describe('dark scheme', () => {
  test.use({ colorScheme: 'dark' });
  test('the derived dark step is applied, not the light accent', async ({ page }) => {
    await signIn(page);
    await page.goto(`/w/${SECOND_SLUG}`);
    const bg = await page.locator('.ws-mark').evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(bg).not.toBe(rgb(SECOND_ACCENT));
    expect(bg).not.toBe(rgb('#b9a6ee')); // and not the product's dark plum either
  });
});

test('an unreadable accent is refused with the nearest passing shade, which then applies', async ({
  page,
}) => {
  await signUpFresh(page, 'branding');
  const slug = await createWorkspace(page, 'Branding');
  await page.goto(`/w/${slug}/settings/branding`);
  const hex = page.getByTestId('accent-hex');
  await hex.fill('#ffd400');
  await expect(page.getByText(/Would not be readable everywhere/u)).toBeVisible();

  // The API refuses it too, whatever the page shows.
  await page.getByRole('button', { name: 'Save accent' }).click();
  await expect(formError(page)).toContainText('would not be readable');

  const use = page.getByRole('button', { name: /^Use #/u });
  const suggestion = ((await use.innerText()).match(/#[0-9a-f]{6}/u) ?? [''])[0];
  await use.click();
  await expect(hex).toHaveValue(suggestion);
  await expect(page.getByText(/Passes WCAG AA/u)).toBeVisible();
  await page.getByRole('button', { name: 'Save accent' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'is now this workspace' })).toBeVisible();
  await expect(page.locator('.ws-mark')).toHaveCSS('background-color', rgb(suggestion));
});
