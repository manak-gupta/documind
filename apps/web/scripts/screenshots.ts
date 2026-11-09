// Captures the product tour as PNGs for the README (and for reviewing the UI).
// Needs the full stack running (dev:api, dev:worker, dev:web) and an account with documents:
//   SCREENSHOT_EMAIL=... SCREENSHOT_PASSWORD=... npm run screenshots -w @documind/web
import { chromium, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const EMAIL = process.env.SCREENSHOT_EMAIL ?? 'debug1@test.dev';
const PASSWORD = process.env.SCREENSHOT_PASSWORD ?? 'password123';
const QUESTION = process.env.SCREENSHOT_QUESTION ??
  'What BLEU score did the big model get on English-to-French, and how long did it take to train?';
const OUT = process.env.OUT_DIR ?? '../../docs/screenshots';

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
}

async function askAndWait(page: Page, question: string) {
  await page.getByRole('textbox').fill(question);
  await page.getByRole('button', { name: 'Ask' }).click();
  // Done = the verified citation list has rendered (or the "not found" reply).
  await page.locator('button[title^="“"]').or(page.getByText(/couldn.t find/)).first().waitFor({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Ask' }).waitFor();
}

// ---- Desktop, light ----
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await context.newPage();

  await page.goto(`${BASE}/login`);
  await page.getByRole('button', { name: 'Sign in' }).waitFor();
  await page.screenshot({ path: `${OUT}/01-login.png` });

  await login(page);
  await page.getByRole('button', { name: 'New conversation' }).first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/02-workspace.png` });

  await askAndWait(page, QUESTION);
  await page.screenshot({ path: `${OUT}/03-answer.png` });

  await page.getByText('Why this answer?').last().click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/04-trace.png` });

  // Open the first citation: the viewer should land on the page with the passage highlighted.
  await page.locator('button[title^="“"]').first().click();
  await page.locator('[data-highlight]').first().waitFor({ timeout: 30_000 }).catch(() => console.warn('no highlight found'));
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/05-source-viewer.png` });
  await context.close();
}

// ---- Desktop, dark ----
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await context.newPage();
  await login(page);
  await page.locator('a[href^="/c/"]').first().click();
  await page.getByText('Why this answer?').last().waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/06-dark.png` });
  await context.close();
}

// ---- Mobile ----
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await login(page);
  // On mobile, conversations live in the slide-over menu.
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/07-mobile-menu.png` });
  await page.locator('a[href^="/c/"]:visible').first().click(); // not the hidden desktop sidebar's copy
  await page.getByText('Why this answer?').last().waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/08-mobile-chat.png` });
  await context.close();
}

await browser.close();
console.log(`Screenshots written to ${OUT}`);
