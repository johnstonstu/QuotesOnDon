import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUOTES_DIR = join(ROOT, 'data/quotes');

const quotes = readdirSync(QUOTES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((file) => ({ file, data: JSON.parse(readFileSync(join(QUOTES_DIR, file), 'utf8')) }));

test('the store validates against its schema', () => {
  execFileSync('node', [join(ROOT, 'tools/validate-quotes.mjs')], { cwd: ROOT, stdio: 'pipe' });
});

test('ids are unique and match their filenames', () => {
  const ids = new Set();
  for (const { file, data } of quotes) {
    assert.equal(`${data.id}.json`, file, `${file} id mismatch`);
    assert.ok(!ids.has(data.id), `duplicate id ${data.id}`);
    ids.add(data.id);
  }
});

test('no two quotes carry the same wording', () => {
  const seen = new Map();
  for (const { file, data } of quotes) {
    const key = data.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    assert.ok(!seen.has(key), `${file} duplicates ${seen.get(key)}`);
    seen.set(key, file);
  }
});

test('every quote cites a retrievable source', () => {
  for (const { file, data } of quotes) {
    assert.ok(Array.isArray(data.sources) && data.sources.length > 0, `${file} has no sources`);
    for (const source of data.sources) {
      assert.match(source.url, /^https?:\/\//, `${file} source url is not http(s)`);
      assert.ok(['primary', 'secondary', 'reference'].includes(source.type), `${file} source type is not one of the three`);
    }
  }
});

test('a meme-circulated quote never publishes on circulation alone', () => {
  for (const { file, data } of quotes) {
    if (!data.tags?.includes('from-meme')) continue;
    const corroborating = data.sources.filter((s) => s.type !== 'reference');
    assert.ok(
      corroborating.length > 0,
      `${file} is tagged from-meme and cites only reference sources — circulation is not evidence`,
    );
  }
});

test('a quote claiming a primary source actually holds one', () => {
  for (const { file, data } of quotes) {
    if (data.confidence !== 'primary') continue;
    assert.ok(
      data.sources.some((s) => s.type === 'primary'),
      `${file} claims primary confidence without a primary source`,
    );
  }
});

test('nothing is marked published without a status', () => {
  for (const { file, data } of quotes) {
    assert.ok(['published', 'draft', 'retracted'].includes(data.status), `${file} has status "${data.status}"`);
  }
});

test('the built site is not older than the quote store', () => {
  const dist = join(ROOT, 'dist/quotes-index.json');
  if (!existsSync(dist)) {
    // Building is the caller's job; skip rather than fail a fresh checkout.
    return;
  }
  const builtAt = statSync(dist).mtimeMs;
  const newestQuote = Math.max(
    ...readdirSync(QUOTES_DIR).map((f) => statSync(join(QUOTES_DIR, f)).mtimeMs),
  );
  assert.ok(
    builtAt >= newestQuote,
    'dist/ was built before the most recent quote landed — run npm run build',
  );
  const index = JSON.parse(readFileSync(dist, 'utf8'));
  const published = quotes.filter((q) => q.data.status === 'published');
  assert.equal(index.length, published.length, 'dist/quotes-index.json does not match the store');
});