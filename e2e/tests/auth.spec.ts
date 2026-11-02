import {
  DEMO_EMAIL,
  expect,
  formError,
  MAIN_SLUG,
  signIn,
  signOut,
  signUpFresh,
  test,
  VIEWER_EMAIL,
  VIEWER_PASSWORD,
} from '../fixtures';

test('the demo account lands in its first workspace', async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(new RegExp(`/w/${MAIN_SLUG}$`, 'u'));
  await expect(page.getByRole('heading', { name: 'Dashboards' })).toBeVisible();
  await expect(page.getByText(DEMO_EMAIL)).toBeVisible();
});

test('the login printed on the sign-in page is the read-only one, and it works', async ({
  page,
}) => {
  // The hosted demo publishes this page. The owner's password is secret there
  // (packages/db/src/seed-key.ts), so the page must print the viewer, never sam.
  await page.goto('/sign-in');
  const hint = page.locator('.auth-demo');
  await expect(hint).toContainText('Read-only');
  const [email, password] = await hint.locator('code').allTextContents();
  expect([email, password]).toEqual([VIEWER_EMAIL, VIEWER_PASSWORD]);
  await expect(page.getByText(DEMO_EMAIL)).toHaveCount(0);

  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${MAIN_SLUG}$`, 'u'));
  await expect(page.getByRole('heading', { name: 'Dashboards' })).toBeVisible();
});

test('a wrong password is one answer, whatever was wrong', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(formError(page)).toHaveText('That email address and password do not match.');
});

test('a deep link survives signing in', async ({ page }) => {
  await page.goto(`/w/${MAIN_SLUG}/settings/members`);
  await expect(page).toHaveURL(/\/sign-in\?next=/u);
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill('demo-password-2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${MAIN_SLUG}/settings/members$`, 'u'));
});

test('a new account is asked to create its first workspace, then sign out works', async ({
  page,
}) => {
  await signUpFresh(page, 'newcomer');
  await expect(page.getByRole('heading', { name: 'New workspace' })).toBeVisible();
  await page.getByLabel('Name').fill('Newcomer Co');
  await page.getByLabel('Address').fill(`newcomer-${String(Date.now()).slice(-8)}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByText('No dashboards yet.')).toBeVisible();
  await signOut(page);
});
