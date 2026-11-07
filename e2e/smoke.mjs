// End-to-end smoke test: landing → briefing → 90 s crisis (at ?speed) → results → share card.
// Usage: node e2e/smoke.mjs [baseUrl] [--mobile]
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const base = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://127.0.0.1:5173/';
const mobile = process.argv.includes('--mobile');
const out = 'e2e/out';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext(mobile ? { ...devices['iPhone 13'] } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const tag = mobile ? 'm' : 'd';

await page.goto(base + '?speed=6', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/${tag}-1-landing.png` });
await page.fill('.landing input', 'Test Operator');
await page.click('text=START EMERGENCY');
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/${tag}-2-briefing.png` });
if (await page.locator('.briefing').count()) await page.locator('.briefing').click({ timeout: 3000 }).catch(() => {});
await page.waitForSelector('.hud', { timeout: 15000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/${tag}-3-play.png` });
// act: pick the first urgent item, then press the first enabled action
const urgent = page.locator('.urgent li').first();
if (await urgent.count()) await urgent.click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/${tag}-4-selected.png` });
const btn = page.locator('.right .act:not([disabled])').first();
if (await btn.count()) await btn.click();
await page.waitForTimeout(300);
// select a line and run grid analysis
await page.evaluate(() => {});
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/${tag}-5-mid.png` });
await page.waitForSelector('.results', { timeout: 60000 });
await page.waitForTimeout(3500);
await page.screenshot({ path: `${out}/${tag}-6-results.png` });
await page.waitForSelector('.rsec', { timeout: 20000 });
const stability = await page.locator('.stability .num').innerText();
if (!/^\d+/.test(stability)) { console.error('E2E FAILED: no stability score shown', stability); process.exit(1); }
const sections = await page.locator('.rsec').count();
if (sections < 3) { console.error('E2E FAILED: report sections missing', sections); process.exit(1); }
await page.screenshot({ path: `${out}/${tag}-7-report.png`, fullPage: true });
const card = await page.evaluate(() => document.querySelector('.card-wrap canvas')?.toDataURL('image/png').length ?? 0);
console.log('card data url length', card);
await page.locator('.results').evaluate((el) => el.scrollTo(0, el.scrollHeight));
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/${tag}-8-share.png` });
console.log('errors', errors.length ? errors : 'none');
await browser.close();
// assertions: the run must reach a scored report with a drawn card and no errors
const fail = [];
if (card < 50000) fail.push(`share card looks empty (${card} bytes)`);
if (errors.length) fail.push(`${errors.length} console errors`);
if (fail.length) { console.error('E2E FAILED:', fail.join('; ')); process.exit(1); }
console.log('E2E PASSED', tag);
