/**
 * The whole product in one flow: a new workspace, an API key, events sent to
 * the ingest service as a customer's backend would, a lane built with the
 * sentence editor, and the events arriving on the chart once the aggregator
 * has rolled them up.
 */
import { createKey, createWorkspace, expect, sendEvents, signUpFresh, test } from '../fixtures';

test('events sent with a key show up on a lane built in the sentence editor', async ({
  page,
  request,
}) => {
  await signUpFresh(page, 'pipeline');
  const slug = await createWorkspace(page, 'Pipeline');
  const key = await createKey(page, slug);

  const now = Date.now();
  const events = Array.from({ length: 12 }, (_, i) => ({
    event: 'trial_started',
    userId: `user-${String(i % 5)}`,
    timestamp: new Date(now - i * 60_000).toISOString(),
    properties: { plan: i % 3 === 0 ? 'business' : 'team', seats: 3 },
  }));
  const response = await sendEvents(request, key, events);
  expect(response.status()).toBe(202);
  expect(await response.json()).toMatchObject({ accepted: 12, duplicates: 0 });

  // A key from another workspace never reaches this one: an unknown key is a 401.
  expect(
    (await sendEvents(request, 'sk_not_a_real_key_00000000000', events.slice(0, 1))).status(),
  ).toBe(401);

  await page.goto(`/w/${slug}`);
  await page.getByLabel('Name').fill('Trials');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(new RegExp(`/w/${slug}/d/[a-z0-9]+$`, 'u'));
  const dashboard = page.url();

  // The catalog lists only what the workspace has sent, and only once the
  // aggregator has rolled it up (a few seconds), so poll the editor.
  await expect(async () => {
    await page.goto(`${dashboard}?edit=new`);
    await expect(page.getByLabel('Event')).toHaveValue('trial_started', { timeout: 1000 });
  }).toPass({ timeout: 30_000 });

  await page.getByLabel('Break down by').selectOption('plan');
  await page.getByLabel('Show as').selectOption('stacked');
  await page.getByLabel('Title (optional)').fill('Trials by plan');
  await page.getByRole('button', { name: 'Add lane' }).click();
  await page.waitForURL(dashboard);

  const lane = page.getByTestId('lane');
  await expect(lane).toHaveCount(1);
  await expect(lane.getByRole('heading', { name: 'Trials by plan' })).toBeVisible();
  await expect(lane.getByTestId('readout')).toContainText('team');
  await expect(lane.getByTestId('readout')).toContainText('business');
  const values = (await lane.getByTestId('readout-value').allInnerTexts()).map(Number);
  expect(values.reduce((a, b) => a + b, 0)).toBe(12);

  // A retried batch (same ids and timestamps) is stored once.
  const withIds = events
    .slice(0, 3)
    .map((e, i) => ({ ...e, id: `00000000-0000-4000-8000-00000000000${String(i)}` }));
  expect(await (await sendEvents(request, key, withIds)).json()).toMatchObject({
    accepted: 3,
    duplicates: 0,
  });
  expect(await (await sendEvents(request, key, withIds)).json()).toMatchObject({
    accepted: 0,
    duplicates: 3,
  });

  // Edit the sentence: count -> unique users, no breakdown, as a number.
  await lane.getByRole('link', { name: 'Edit Trials by plan' }).click();
  await page.getByLabel('Metric').selectOption('unique_users');
  await page.getByLabel('Break down by').selectOption('');
  await page.getByLabel('Show as').selectOption('number');
  await page.getByRole('button', { name: 'Save lane' }).click();
  await page.waitForURL(dashboard);
  await expect(page.getByTestId('lane').locator('.lane-figure strong')).toHaveText('5');

  // Remove is two deliberate steps: open the lane's menu, ask to remove, then confirm.
  await lane.getByText('More', { exact: true }).click();
  await lane.getByRole('button', { name: 'Remove Trials by plan…' }).click();
  await expect(lane.getByText(/Remove Trials by plan from this dashboard\?/u)).toBeVisible();
  await page.getByRole('button', { name: 'Remove Trials by plan', exact: true }).click();
  await expect(page.getByText('This dashboard has no lanes yet.')).toBeVisible();
});
