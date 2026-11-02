/**
 * Leaving a workspace is never one stray click: the first button only asks,
 * the question says what is lost, and Stay backs out.
 */
import {
  expect,
  MAIN_SLUG,
  signIn,
  signUpFresh,
  test,
  VIEWER_EMAIL,
  VIEWER_PASSWORD,
} from '../fixtures';

test('leaving asks again in words, and Stay backs out with nothing changed', async ({ page }) => {
  await signIn(page, VIEWER_EMAIL, VIEWER_PASSWORD);
  await page.goto(`/w/${MAIN_SLUG}/settings/members`);
  await expect(page.getByRole('button', { name: 'Leave workspace', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Leave Fieldnote…' }).click();
  await expect(
    page.getByText(/Leave Fieldnote\? You lose access to its dashboards/u),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stay' }).click();

  await expect(page.getByRole('button', { name: 'Leave workspace', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Leave Fieldnote…' })).toBeVisible();
  await page.goto(`/w/${MAIN_SLUG}`);
  await expect(page.getByRole('heading', { name: 'Dashboards' })).toBeVisible();
});

test('the second step really submits, and a refusal is said in place', async ({ page }) => {
  // A sole owner: the API refuses (a workspace keeps an owner), so the test
  // proves the confirm reaches the server without stranding any seeded account.
  await signUpFresh(page, 'leaver');
  const slug = `leaver-${String(Date.now()).slice(-8)}`;
  await page.getByLabel('Name').fill('Leaver Co');
  await page.getByLabel('Address').fill(slug);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByText('No dashboards yet.')).toBeVisible();

  await page.goto(`/w/${slug}/settings/members`);
  await page.getByRole('button', { name: 'Leave Leaver Co…' }).click();
  await page.getByRole('button', { name: 'Leave workspace', exact: true }).click();
  // Filtered: Next's route announcer is an (empty) role="alert" too.
  await expect(
    page.getByRole('alert').filter({ hasText: 'A workspace must keep at least one owner.' }),
  ).toBeVisible();
});
