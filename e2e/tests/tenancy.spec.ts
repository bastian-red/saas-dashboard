/**
 * The isolation promise, through the browser: a workspace you do not belong to
 * is "Nothing here", indistinguishable from one that does not exist, for the
 * workspace, its dashboards and its settings. The API-level proof (every route
 * x every foreign id, and raw SQL as the app role) is the integration lane;
 * this is the same promise as a person meets it.
 */
import {
  expect,
  MAIN_SLUG,
  signOut,
  OUTSIDER_EMAIL,
  OUTSIDER_PASSWORD,
  SECOND_SLUG,
  signIn,
  test,
  VIEWER_EMAIL,
  VIEWER_PASSWORD,
} from '../fixtures';

test('an outsider gets 404 for every page of another workspace', async ({ page }) => {
  // Read a real dashboard id as a member first, then try it as an outsider.
  await signIn(page);
  const href = (await page.locator('.dash-list a').first().getAttribute('href')) ?? '';
  expect(href).toMatch(new RegExp(`^/w/${MAIN_SLUG}/d/[a-z0-9]+$`, 'u'));
  await signOut(page);

  await signIn(page, OUTSIDER_EMAIL, OUTSIDER_PASSWORD);
  await expect(page).toHaveURL(new RegExp(`/w/${SECOND_SLUG}$`, 'u'));
  for (const path of [
    `/w/${MAIN_SLUG}`,
    href,
    `/w/${MAIN_SLUG}/settings/members`,
    `/w/${MAIN_SLUG}/settings/keys`,
    `/w/${MAIN_SLUG}/settings/billing`,
  ]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    await expect(page.getByRole('heading', { name: 'Nothing here' }), path).toBeVisible();
  }
});

test('the switcher lists only workspaces you belong to', async ({ page }) => {
  await signIn(page, VIEWER_EMAIL, VIEWER_PASSWORD);
  await page.locator('.switcher summary').click();
  const items = page.locator('.switcher-menu li a').filter({ hasNotText: 'New workspace' });
  await expect(items).toHaveCount(1);
  expect((await page.goto(`/w/${SECOND_SLUG}`))?.status()).toBe(404);
});
