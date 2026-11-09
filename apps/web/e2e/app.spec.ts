import { expect, test, type Page } from '@playwright/test';
import { makePdf } from '../../api/src/test/pdf.ts';

// A small, real, text-based PDF with two sections across two pages.
const reportPdf = () =>
  makePdf(
    [
      [
        { text: 'Solar Power Report', size: 20 },
        { text: 'Rooftop solar capacity in the region grew by forty percent during the year.' },
        { text: 'Installation costs fell because panel prices continued to decline.' },
        { text: 'Most new systems were installed on residential buildings.' },
      ],
      [
        { text: 'Grid Storage', size: 18 },
        { text: 'Battery storage helped balance the grid during evening demand peaks.' },
        { text: 'Utilities plan to double battery capacity over the next three years.' },
      ],
    ],
    'Solar Power Report',
  );

async function signUp(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Email').fill(`e2e-${crypto.randomUUID()}@test.dev`);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/');
}

async function uploadReport(page: Page) {
  await page.locator('input[type=file]').setInputFiles({
    name: 'solar-report.pdf', mimeType: 'application/pdf', buffer: reportPdf(),
  });
  // Live progress arrives over SSE; the row ends up "ready" with its page count.
  await expect(page.getByText('2 pages')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Solar Power Report').first()).toBeVisible();
}

test('sign up, upload, ask, verify citation, open the source with the passage highlighted', async ({ page }) => {
  await signUp(page);
  await expect(page.getByText('Start by uploading a PDF')).toBeVisible();

  await uploadReport(page);
  await expect(page.getByText('What do you want to know?')).toBeVisible();

  await page.getByRole('textbox').fill('How much did rooftop solar capacity grow?');
  await page.getByRole('button', { name: 'Ask' }).click();

  // The streamed answer, with a verified citation chip and the cited source listed.
  await expect(page.getByText(/According to your documents/)).toBeVisible({ timeout: 30_000 });
  const sourceChip = page.locator('button[title^="“"]').first();
  await expect(sourceChip).toContainText('Solar Power Report');
  await expect(sourceChip).toContainText('p. 1');

  // The trace panel explains the retrieval.
  await page.getByRole('button', { name: /Why this answer/ }).click();
  await expect(page.getByText('Citations rejected')).toBeVisible();
  await expect(page.getByText(/vec \d/).first()).toBeVisible();

  // Clicking the citation opens the PDF at the cited page, with the quote highlighted.
  await sourceChip.click();
  await expect(page.getByText('Page 1 of 2')).toBeVisible();
  await expect(page.locator('[data-highlight]').first()).toBeVisible({ timeout: 15_000 });

  // The conversation (and its trace) survives a reload.
  await page.reload();
  await expect(page.getByText(/According to your documents/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Why this answer/ })).toBeVisible();
});

test('the same question is answered from the cache the second time', async ({ page }) => {
  await signUp(page);
  await uploadReport(page);
  const ask = async () => {
    await page.getByRole('button', { name: 'New conversation' }).first().click();
    await page.getByRole('textbox').fill('What happened to installation costs?');
    await page.getByRole('button', { name: 'Ask' }).click();
    await expect(page.locator('button[title^="“"]').first()).toBeVisible({ timeout: 30_000 });
  };
  await ask();
  await ask();
  await expect(page.getByText('cached · 0 tokens')).toBeVisible();
});

test('non-PDF uploads are rejected with a clear message', async ({ page }) => {
  await signUp(page);
  await page.locator('input[type=file]').setInputFiles({
    name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('this is not a pdf'),
  });
  await expect(page.getByText(/Only PDF files are supported/)).toBeVisible();
});

test('signing out returns to the login page and protects the app', async ({ page }) => {
  await signUp(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});

test('wrong password shows an error without revealing whether the account exists @mobile', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('nobody@test.dev');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect');
});
