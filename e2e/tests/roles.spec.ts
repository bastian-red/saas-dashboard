/**
 * Roles as a viewer meets them: dashboards readable, nothing to edit, no
 * settings they cannot use. Hiding is a courtesy; the API's 403 is the rule,
 * and the integration lane asserts the full role x action matrix.
 */
import {
  expect,
  HERO_DASHBOARD,
  MAIN_SLUG,
  signIn,
  test,
  VIEWER_EMAIL,
  VIEWER_PASSWORD,
} from '../fixtures';

test('a viewer reads the dashboard and finds no way to change it', async ({ page }) => {
  await signIn(page, VIEWER_EMAIL, VIEWER_PASSWORD);
  await page.getByRole('link', { name: new RegExp(HERO_DASHBOARD, 'u') }).click();
  await expect(page.getByTestId('lane')).toHaveCount(6);
  await expect(page.getByRole('link', { name: '+ Add lane' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Edit/u })).toHaveCount(0);
  await expect(page.getByText('Last 30 days')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'New dashboard' })).toHaveCount(0);

  const nav = page.getByRole('navigation', { name: 'Workspace' });
  await expect(nav.getByRole('link', { name: 'Members' })).toBeVisible();
  for (const hidden of ['API keys', 'Plan & billing', 'Branding'])
    await expect(nav.getByRole('link', { name: hidden })).toHaveCount(0);

  await page.goto(`/w/${MAIN_SLUG}/settings/members`);
  await expect(page.getByRole('heading', { name: 'Invite someone' })).toHaveCount(0);
  expect((await page.goto(`/w/${MAIN_SLUG}/settings/branding`))?.status()).toBe(404);
});
