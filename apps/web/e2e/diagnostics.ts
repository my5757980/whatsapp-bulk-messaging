import type { Page } from '@playwright/test';

/**
 * Collects browser errors and failed API calls, and adds them (with the visible page text) to the
 * message of a failing check, so CI annotations show why a step failed.
 */
export function collectDiagnostics(page: Page) {
  const notes: string[] = [];
  page.on('pageerror', (error) => notes.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') notes.push(`console: ${message.text().slice(0, 300)}`);
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      notes.push(`HTTP ${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
    }
  });
  return {
    async check(step: () => Promise<void>): Promise<void> {
      try {
        await step();
      } catch (error) {
        const text = await page.locator('body').innerText().catch(() => '(no page text)');
        throw new Error(`${(error as Error).message}\n--- page text:\n${text.slice(0, 700)}\n--- browser notes:\n${notes.slice(-15).join('\n') || '(none)'}`, {
          cause: error,
        });
      }
    },
  };
}
