import { test, expect } from '@playwright/test';

test.describe('llm-d Inference Observatory End-to-End Local Demo Suite', () => {
  test('1-4 & 9-10: Submit prompt, observe request ID, receive streamed output, complete request, verify simulated badge and aggregate metrics', async ({
    page,
  }) => {
    await page.goto('/');

    // 10. Verify mock mode banner is visibly marked as simulated
    await expect(page.getByTestId('mock-mode-banner')).toBeVisible();
    await expect(page.getByTestId('mock-mode-banner')).toContainText('LOCAL DEMO / MOCK MODE ACTIVE');

    // 1. Submit a prompt
    await page.getByTestId('prompt-input').fill('Trace prefix-cache affinity routing on CPU GKE');
    await page.getByTestId('scenario-select').selectOption('success');
    await page.getByTestId('send-button').click();

    // 2 & 3 & 4. Observe request ID, receive streamed output, and complete request
    await expect(page.getByTestId('request-id-value')).toContainText('req_', { timeout: 10000 });
    await expect(page.getByTestId('request-status-badge')).toHaveText('completed', { timeout: 10000 });
    await expect(page.getByTestId('stream-output-text')).toContainText('[SIMULATED LOCAL DEMO]');

    // Inspect Live Lifecycle Timeline
    await page.getByTestId('nav-tab-timeline').click();
    await expect(page.getByTestId('timeline-event-request.accepted')).toBeVisible();
    await expect(page.getByTestId('timeline-event-gateway.forwarded')).toBeVisible();
    await expect(page.getByTestId('timeline-event-routing.started')).toBeVisible();
    await expect(page.getByTestId('timeline-event-endpoint.selected')).toBeVisible();
    await expect(page.getByTestId('timeline-event-model.first_token')).toBeVisible();
    await expect(page.getByTestId('timeline-event-request.completed')).toBeVisible();

    // Inspect Interactive Topology
    await page.getByTestId('nav-tab-topology').click();
    await expect(page.getByTestId('topology-canvas')).toBeVisible();
    await expect(page.getByTestId('inspector-node-title')).toContainText('Endpoint Picker');

    // 9. Show aggregate metrics separately
    await page.getByTestId('nav-tab-metrics').click();
    await expect(page.getByTestId('aggregate-metrics-notice')).toContainText(
      'Never interpret a global queue gauge',
    );
    await expect(page.getByTestId('metric-card-llm_d_epp_ready_endpoints')).toBeVisible();
  });

  test('5: Cancel an in-flight request', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('scenario-select').selectOption('cancel');
    await page.getByTestId('max-tokens-input').fill('40');
    await page.getByTestId('send-button').click();

    // Wait briefly for stream to start, then click Cancel
    await expect(page.getByTestId('cancel-button')).toBeEnabled();
    await page.waitForTimeout(100);
    await page.getByTestId('cancel-button').click();

    await expect(page.getByTestId('request-status-badge')).toHaveText('cancelled', { timeout: 10000 });
    await page.getByTestId('nav-tab-timeline').click();
    await expect(page.getByTestId('timeline-event-request.cancelled')).toBeVisible();
  });

  test('6: Simulate a backend failure (HTTP 429 saturation rejection)', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('scenario-select').selectOption('saturated');
    await page.getByTestId('send-button').click();

    await expect(page.getByTestId('playground-error-alert')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('request-status-badge')).toHaveText('failed', { timeout: 10000 });

    await page.getByTestId('nav-tab-timeline').click();
    await expect(page.getByTestId('timeline-event-queue.observed')).toBeVisible();
    await expect(page.getByTestId('timeline-event-request.failed')).toBeVisible();
  });

  test('7 & 8: Render a partial trace and delayed trace enrichment', async ({ page }) => {
    await page.goto('/');

    // 7. Partial trace scenario
    await page.getByTestId('scenario-select').selectOption('partial_trace');
    await page.getByTestId('max-tokens-input').fill('8');
    await page.getByTestId('send-button').click();
    await expect(page.getByTestId('request-status-badge')).toHaveText('completed', { timeout: 10000 });

    await page.getByTestId('nav-tab-timeline').click();
    await expect(page.getByTestId('trace-enrichment-status')).toContainText('partial');
    await expect(page.getByTestId('trace-warning-banner')).toContainText('Partial trace');
    await expect(page.getByTestId('prefill-duration-value')).toHaveText('Unavailable');

    // 8. Delayed trace enrichment scenario
    await page.getByTestId('nav-tab-playground').click();
    await page.getByTestId('scenario-select').selectOption('delayed_trace');
    await page.getByTestId('send-button').click();
    await expect(page.getByTestId('request-status-badge')).toHaveText('completed', { timeout: 10000 });

    await page.getByTestId('nav-tab-timeline').click();
    await expect(page.getByTestId('trace-enrichment-status')).toContainText('enriched', {
      timeout: 5000,
    });
    await expect(page.getByTestId('timeline-event-trace.enriched')).toBeVisible({ timeout: 5000 });
  });
});
