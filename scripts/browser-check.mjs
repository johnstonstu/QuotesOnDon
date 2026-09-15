#!/usr/bin/env node
/**
 * Browser checks for the built site. Not run by default in CI (it needs Playwright and a
 * running preview), but it is the fastest way to catch the class of bug that a build
 * cannot: a stale field after the client-side rotation, a broken attribution, a layout
 * that overflows on a phone.
 *
 *   scripts/local.sh start
 *   PLAYWRIGHT_PATH=~/Coding/Construction-Calc/node_modules/playwright node scripts/browser-check.mjs
 *
 * Exits non-zero on the first failed check summary. Prints one line per check.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BASE = process.env.BASE || 'http://127.0.0.1:4321';

let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright'));
} catch {
  console.error(
    'playwright not resolvable. Install it in this project, or point PLAYWRIGHT_PATH at an existing install:\n' +
      '  PLAYWRIGHT_PATH=~/Coding/Construction-Calc/node_modules/playwright node scripts/browser-check.mjs',
  );
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

try {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const quote = (await page.textContent('[data-quote-text]')).trim();
  check('home renders a quote', quote.length > 0, quote.slice(0, 48));

  const homeHtml = await page.content();
  check('no pipeline internals on the public page', !/Ingest evidence|Approved via dashboard/i.test(homeHtml));
  check('no undefined leaking into markup', !/undefined/.test(homeHtml));

  const attrib = (await page.textContent('.quote-attrib')).replace(/\s+/g, ' ');
  check('attribution has no doubled or floating separator', !/ ,|,,/.test(attrib), attrib.slice(0, 64));

  const seen = new Set([quote]);
  for (let i = 0; i < 5; i++) {
    await page.click('#another');
    await page.waitForTimeout(320);
    seen.add((await page.textContent('[data-quote-text]')).trim());
  }
  check('rotation cycles quotes', seen.size >= 3, `${seen.size} distinct over 5 clicks`);
  check('rotation pushes a permalink', /\/quotes\/[a-z0-9-]+\/$/.test(page.url()), page.url().replace(BASE, ''));

  await page.goto(`${BASE}/quotes/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#list .card');
  const index = await (await page.request.get(`${BASE}/quotes-index.json`)).json();
  const cards = await page.locator('#list .card').count();
  check('archive lists every published quote', cards === index.length, `${cards} of ${index.length}`);

  await page.fill('#q', 'fifth avenue');
  await page.waitForTimeout(150);
  check('search narrows the list', (await page.locator('#list .card').count()) === 1);

  await page.fill('#q', 'zzzz');
  await page.waitForTimeout(150);
  check('empty state appears', (await page.locator('#list .card').count()) === 0 && (await page.locator('#empty').isVisible()));

  const first = index[0];
  await page.goto(`${BASE}/quotes/${first.id}/`, { waitUntil: 'networkidle' });
  const provenance = await page.textContent('.provenance');
  check('permalink shows provenance', provenance.length > 40);
  const rel = await page.getAttribute('.provenance a[href^="http"]', 'rel');
  check('source links are outbound and labelled', /nofollow/.test(rel ?? ''), rel ?? 'none');

  const rss = await (await page.request.get(`${BASE}/rss.xml`)).text();
  check('rss item count matches the store', (rss.match(/<item>/g) ?? []).length === index.length);

  check('no console or page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no horizontal overflow on a phone', overflow <= 1, `${overflow}px`);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);