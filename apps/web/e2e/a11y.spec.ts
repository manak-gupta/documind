import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Automated accessibility checks (axe-core, WCAG 2.1 A/AA rules) on the main screens.
// Fails on "serious" or "critical" violations; minor ones are printed for review.
async function audit(page: Page, name: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  for (const v of results.violations) {
    console.log(`[${name}] ${v.impact}: ${v.id} (${v.nodes.length}) ${v.help}`);
  }
  expect(blocking.map((v) => `${v.id}: ${v.help} -> ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test('login page has no serious accessibility violations', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in' }).waitFor();
  await audit(page, 'login');
});

test('workspace has no serious accessibility violations', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Email').fill(`a11y-${crypto.randomUUID()}@test.dev`);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Start by uploading a PDF')).toBeVisible();
  await audit(page, 'workspace');
});
