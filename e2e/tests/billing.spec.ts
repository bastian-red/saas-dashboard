/**
 * Upgrading through the mock provider: checkout, pay, and the plan changes
 * through the same signed-webhook path a Stripe delivery takes.
 */
import { expect, signUpFresh, createWorkspace, test } from '../fixtures';

test('free to Team through checkout, then cancel through the portal', async ({ page }) => {
  await signUpFresh(page, 'billing');
  const slug = await createWorkspace(page, 'Billing');
  await page.goto(`/w/${slug}/settings/billing`);
  const usage = page.getByTestId('usage');
  await expect(usage.getByRole('heading', { name: 'Free plan' })).toBeVisible();
  await expect(usage).toContainText('of 100,000 events');

  await page.getByRole('button', { name: 'Upgrade to Team' }).click();
  await expect(page.getByRole('heading', { name: /Team for Billing/u })).toBeVisible();
  await page.getByRole('button', { name: /^Pay/u }).click();

  await expect(page).toHaveURL(new RegExp(`/w/${slug}/settings/billing\\?checkout=success`, 'u'));
  await expect(page.getByRole('status').first()).toContainText('Payment received');
  await expect(usage.getByRole('heading', { name: 'Team plan' })).toBeVisible();
  await expect(usage).toContainText('of 5,000,000 events');
  await expect(page.locator('.switcher')).toContainText('team');

  await page.getByRole('button', { name: 'Manage subscription' }).click();
  await page.getByRole('button', { name: 'Cancel subscription' }).click();
  await expect(usage).toContainText('of 100,000 events');
  await expect(usage.locator('.form-error')).toContainText('the Free plan');
});

test('a downgrade is never the primary action on the plans page', async ({ page }) => {
  await signUpFresh(page, 'downgrade');
  const slug = await createWorkspace(page, 'Downgrade');
  await page.goto(`/w/${slug}/settings/billing`);
  await page.getByRole('button', { name: 'Upgrade to Business' }).click();
  await page.getByRole('button', { name: /^Pay/u }).click();
  await expect(
    page.getByTestId('usage').getByRole('heading', { name: 'Business plan' }),
  ).toBeVisible();

  // From Business, Team is a step down: a plain button that says so, with what it takes away.
  const down = page.getByRole('button', { name: 'Downgrade to Team' });
  await expect(down).toBeVisible();
  await expect(down).not.toHaveClass(/button-primary/u);
  await expect(page.getByText(/Drops to 5M events and 15 seats/u)).toBeVisible();
  await expect(page.locator('.plans .button-primary')).toHaveCount(0);
});
