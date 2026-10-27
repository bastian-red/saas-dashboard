import { AGGREGATOR_URL, API_BASE_URL, expect, INGEST_URL, test } from '../fixtures';

test.describe('every service answers /health with its dependencies checked', () => {
  for (const [name, base, deps] of [
    ['api', API_BASE_URL, ['postgres', 'redis']],
    ['ingest', INGEST_URL, ['postgres', 'redis']],
    ['aggregator', AGGREGATOR_URL, ['aggregation', 'postgres']],
  ] as const) {
    test(name, async ({ request }) => {
      const response = await request.get(`${base}/health`);
      expect(response.status()).toBe(200);
      const body = (await response.json()) as {
        service: string;
        status: string;
        checks: { name: string; status: string }[];
      };
      expect(body.service).toBe(name);
      expect(body.checks.map((c) => `${c.name}:${c.status}`).sort()).toEqual(
        deps.map((d) => `${d}:ok`),
      );
    });
  }
});

test('the /status page shows all three services up', async ({ page }) => {
  await page.goto('/status');
  await expect(page.getByTestId('overall')).toHaveText(/Every service is up/u);
  for (const service of ['api', 'ingest', 'aggregator']) {
    await expect(page.locator(`[data-service="${service}"]`)).toContainText('Up');
  }
});
