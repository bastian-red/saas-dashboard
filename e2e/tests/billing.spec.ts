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

  await page.getByRole('button', { name: 'Choose Team' }).click();
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
