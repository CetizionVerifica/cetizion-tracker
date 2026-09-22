import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('../server/.env', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:5273/');
await page.getByLabel('Username').fill(env.AUTH_USERNAME || 'admin');
await page.getByLabel('Password').fill(env.AUTH_PASSWORD);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: '/private/tmp/claude-501/-Users-hayyan-code-cetizion-tracker/0263e9dd-e0f5-45cb-90bf-4b55e898694d/scratchpad/shot-dashboard.png' });
await page.goto('http://localhost:5273/quotations');
await page.waitForTimeout(1800);
await page.screenshot({ path: '/private/tmp/claude-501/-Users-hayyan-code-cetizion-tracker/0263e9dd-e0f5-45cb-90bf-4b55e898694d/scratchpad/shot-quotations.png' });
console.log('ok');
await browser.close();
