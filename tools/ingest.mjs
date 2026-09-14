#!/usr/bin/env node
/**
 * Ingest: find candidate quotes in citable sources, write them to data/candidates/.
 *
 * It never publishes. A candidate becomes a quote only when a human approves it
 * (npm run dash). Every candidate carries the words as published plus the URL they
 * came from and the time it was fetched, because a quote without a retrievable
 * receipt does not belong in this repo.
 *
 * Sources, and why each is ranked where it is:
 *   1. X @realDonaldTrump        — his own words, needs a bearer token (see sources.json)
 *   1b. Truth Social             — his own words, works today via the trumpstruth.org archive feed
 *   2. news (NPR, PBS, GDELT)    — reports quoting him; the article is the receipt
 *   3. memes (Reddit)            — circulation, not evidence; tagged from-meme and
 *                                  blocked from publishing until a real source agrees
 *
 * Politeness: honours robots.txt (including Crawl-delay), spaces requests per host,
 * caps pages per run, and skips a host that disallows the bot.
 *
 * Usage:
 *   node tools/ingest.mjs
 *   node tools/ingest.mjs --source=x-trump --limit=20
 *   node tools/ingest.mjs --dry-run
 *   node tools/ingest.mjs --list
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'data/sources.json'), 'utf8'));

// Credentials for gated sources: repo .env (gitignored) then the Hermes env file.
for (const envFile of [join(ROOT, '.env'), join(process.env.HOME ?? '', '.hermes/.env')]) {
  try {
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  } catch {
    /* a malformed env file is not worth failing the run over */
  }
}
const QUOTES_DIR = join(ROOT, 'data/quotes');
const CANDIDATES_DIR = join(ROOT, 'data/candidates');
const LOG_DIR = join(ROOT, 'data/ingest-log');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const DRY_RUN = args.includes('--dry-run');
const ONLY = flag('source');
const LIMIT = Number(flag('limit', CONFIG.maxArticlesPerRun));
const UA = CONFIG.userAgent;

/* ---------------------------------------------------------------- fetching */

const robotsCache = new Map();
const lastRequest = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function robotsFor(host) {
  if (robotsCache.has(host)) return robotsCache.get(host);
  const rules = { disallow: [], crawlDelay: 1 };
  try {
    const res = await fetch(`https://${host}/robots.txt`, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const text = await res.text();
      let applies = false;
      let sawDelay = 0;
      for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const [field, ...rest] = line.split(':');
        const value = rest.join(':').trim();
        if (/^user-agent$/i.test(field)) applies = value === '*' || UA.toLowerCase().includes(value.toLowerCase());
        else if (applies && /^disallow$/i.test(field)) rules.disallow.push(value);
        else if (applies && /^crawl-delay$/i.test(field)) sawDelay = Number(value) || 0;
      }
      if (sawDelay) rules.crawlDelay = sawDelay;
    }
  } catch {
    /* unreachable robots.txt: stay polite by default */
  }
  robotsCache.set(host, rules);
  return rules;
}

async function politeFetch(url, { kind = 'html', skipRobots = false } = {}) {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const rules = skipRobots ? { disallow: [], crawlDelay: CONFIG.minSecondsBetweenRequests } : await robotsFor(host);
  if (rules.disallow.some((path) => path && parsed.pathname.startsWith(path))) {
    throw new Error(`robots.txt disallows ${parsed.pathname} on ${host}`);
  }
  const gap = Math.max(CONFIG.minSecondsBetweenRequests, rules.crawlDelay) * 1000;
  const since = Date.now() - (lastRequest.get(host) ?? 0);
  if (since < gap) await sleep(gap - since);
  lastRequest.set(host, Date.now());

  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      accept: kind === 'json' ? 'application/json' : 'application/rss+xml,application/atom+xml,application/xml,text/html;q=0.9,*/*;q=0.5',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

/* ------------------------------------------------------------- extraction */

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#8220;|&ldquo;/g, '“')
    .replace(/&#8221;|&rdquo;/g, '”')
    .replace(/&#8217;|&rsquo;|&apos;/g, '’')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

const htmlToText = (html) =>
  decodeEntities(
    String(html)
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/p>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

/** Tag guesser — transparent keyword map, so the archive stays browsable. */
const TAG_MAP = {
  tariff: ['tariff', 'tariffs', 'trade war'],
  immigration: ['border', 'immigrant', 'immigration', 'deport', 'ice '],
  economy: ['inflation', 'economy', 'jobs', 'gas prices', 'interest rate'],
  media: ['fake news', 'media', 'press', 'cnn', 'msnbc', 'new york times', 'journalist'],
  campaign: ['campaign', 'election', 'vote', 'voters', 'rally'],
  china: ['china', 'chinese', 'beijing'],
  russia: ['russia', 'putin', 'ukraine'],
  judiciary: ['court', 'judge', 'supreme court', 'lawsuit', 'prosecutor'],
  golf: ['golf', 'links', 'club championship'],
  foreign: ['nato', 'europe', 'israel', 'iran', 'gaza', 'canada', 'mexico'],
};
const tagsFor = (text) => {
  const lower = text.toLowerCase();
  const hits = Object.entries(TAG_MAP)
    .filter(([, words]) => words.some((w) => lower.includes(w)))
    .map(([tag]) => tag)
    .slice(0, 4);
  return hits.length ? hits : ['general'];
};

const ATTRIBUTION = new RegExp(
  '(trump\\s+(said|says|said,|told|added|argued|claimed|warned|insisted|joked|wrote|posted|declared)' +
    '|said\\s+trump|trump[’\']s\\s+(remarks?|words|comments|post|posting)|according\\s+to\\s+trump|trump:)',
  'i',
);

/** News text: quoted spans that are plainly attributed to him. */
function extractSentenceQuotes(text) {
  const out = [];
  for (const raw of text.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? []) {
    const sentence = raw.trim();
    if (!sentence || !ATTRIBUTION.test(sentence)) continue;
    for (const match of sentence.matchAll(/[“"]([^”"]{25,400})[”"]/g)) {
      const candidate = match[1].trim();
      if (candidate.length < CONFIG.minQuoteChars || candidate.length > CONFIG.maxQuoteChars) continue;
      if (candidate.includes('...') || /[[\]]/.test(candidate)) continue; // elided or edited: a human's job
      out.push({ text: candidate, evidence: sentence });
    }
  }
  return out;
}

/** His own posts: the words as published. Long posts are split into quotable sentences. */
function extractPostText(text) {
  const clean = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return [];
  if (clean.length <= CONFIG.maxQuoteChars) return [{ text: clean, evidence: clean }];

  const sentences = (clean.match(/[^.!?]+[.!?]+/g) ?? []).map((s) => s.trim());
  return sentences
    .filter((s) => s.length >= 60 && s.length <= CONFIG.maxQuoteChars)
    .filter((s) => !/^[#@]/.test(s))
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
    .map((s) => ({ text: s, evidence: clean.slice(0, 600) }));
}

/** Memes: quoted spans in titles or overlay text, attributed to him, that everything else must corroborate. */
function extractMemeQuotes(text) {
  const out = [];
  for (const match of text.matchAll(/[“"]([^”"]{25,300})[”"]/g)) {
    const candidate = match[1].trim();
    if (candidate.length < CONFIG.minQuoteChars) continue;
    if (!/trump/i.test(text)) continue;
    out.push({ text: candidate, evidence: text.slice(0, 400) });
    if (out.length >= 2) break;
  }
  return out;
}

const EXTRACTORS = {
  'sentence-quote': extractSentenceQuotes,
  post: extractPostText,
  'meme-quote': extractMemeQuotes,
};

/* ---------------------------------------------------------------- adapters */

function parseFeed(xml) {
  const rssItems = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const atomItems = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  const blocks = rssItems.length ? rssItems : atomItems;
  const tag = (block, names) => {
    for (const name of names) {
      const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
      if (m) return m[1];
    }
    return null;
  };
  return blocks.map((block) => {
    const linkTag = block.match(/<link[^>]*href="([^"]+)"/i);
    const pub = tag(block, ['pubDate', 'published', 'updated']);
    const body = tag(block, ['content:encoded', 'content', 'description', 'summary']);
    return {
      title: htmlToText(tag(block, ['title']) ?? ''),
      url: (tag(block, ['link']) ?? linkTag?.[1] ?? '').trim(),
      publishedAt: pub ? new Date(decodeEntities(pub.trim())).toISOString().slice(0, 10) : null,
      body: body ? htmlToText(body) : '',
    };
  });
}

async function fetchFeedItems(source) {
  const res = await politeFetch(source.url, { kind: 'xml' });
  return parseFeed(await res.text()).filter((item) => item.url);
}

async function itemsFromReddit(source) {
  // Reddit's robots.txt disallows generic crawlers entirely, so this uses the
  // credentialed API (free "script" app, client_credentials) instead of the feeds.
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      'no Reddit app credentials — set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET (free "script" app at ' +
        'https://www.reddit.com/prefs/apps). The anonymous feed route is deliberately not used: reddit.com/robots.txt disallows it.',
    );
  }
  const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20_000),
  });
  if (!tokenRes.ok) throw new Error(`Reddit token request failed: HTTP ${tokenRes.status}`);
  const token = (await tokenRes.json())?.access_token;
  if (!token) throw new Error('Reddit returned no access token');

  const out = [];
  for (const sub of source.subs ?? []) {
    const res = await politeFetch(`https://oauth.reddit.com/r/${sub}/top?t=month&limit=10&raw_json=1`, { kind: 'json', skipRobots: true });
    const listing = await res.json();
    for (const child of listing?.data?.children ?? []) {
      const post = child.data ?? {};
      out.push({
        title: post.title ?? '',
        url: `https://www.reddit.com${post.permalink ?? ''}`,
        publishedAt: post.created_utc ? new Date(post.created_utc * 1000).toISOString().slice(0, 10) : null,
        body: htmlToText(post.selftext || post.title || ''),
        sub,
      });
    }
  }
  return out;
}

async function itemsFromGdelt(source) {
  const query = encodeURIComponent('"Trump said" sourcelang:english');
  const res = await politeFetch(`${source.url}?query=${query}&mode=artlist&maxrecords=10&format=json&timespan=1d`, { kind: 'json' });
  const body = (await res.text()).trim();
  if (!body.startsWith('{')) {
    throw new Error(`GDELT returned a throttle notice instead of JSON: ${body.slice(0, 100)}…`);
  }
  return (JSON.parse(body).articles ?? []).map((a) => ({
    title: a.title,
    url: a.url,
    publishedAt: a.seendate ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}` : null,
    body: '',
  }));
}

/** X API v2. Needs X_BEARER_TOKEN; reading another account needs the paid tier. */
async function itemsFromX(source) {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    throw new Error(
      'no X_BEARER_TOKEN in the environment — set one from an X developer app to read @' +
        source.handle +
        ' (X\'s free tier cannot read another account\'s posts)',
    );
  }
  const auth = { authorization: `Bearer ${token}`, 'user-agent': UA, accept: 'application/json' };
  const lookup = await fetch(`https://api.x.com/2/users/by/username/${source.handle}`, { headers: auth, signal: AbortSignal.timeout(20_000) });
  if (!lookup.ok) throw new Error(`X user lookup failed: HTTP ${lookup.status}`);
  const userId = (await lookup.json())?.data?.id;
  if (!userId) throw new Error('X user lookup returned no id');

  const url =
    `https://api.x.com/2/users/${userId}/tweets?max_results=20` +
    '&exclude=replies,retweets&tweet.fields=created_at,text&expansions=attachments.media_keys';
  const res = await fetch(url, { headers: auth, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`X timeline failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.data ?? []).map((tweet) => ({
    title: `X post ${tweet.id}`,
    url: `https://x.com/${source.handle}/status/${tweet.id}`,
    publishedAt: (tweet.created_at ?? '').slice(0, 10) || null,
    body: htmlToText(tweet.text ?? ''),
  }));
}

async function itemsFromHtmlList(source) {
  const res = await politeFetch(source.url, { kind: 'html' });
  const html = await res.text();
  const seen = new Set();
  const out = [];
  for (const match of html.matchAll(/<a[^>]+href="(\/documents\/[^"]+)"[^>]*>([\s\S]{5,160}?)<\/a>/gi)) {
    const url = new URL(match[1], source.url).href;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title: htmlToText(match[2]), url, publishedAt: null, body: '' });
  }
  return out;
}

const ADAPTERS = {
  'post-feed': fetchFeedItems,
  rss: fetchFeedItems,
  'reddit-rss': itemsFromReddit,
  gdelt: itemsFromGdelt,
  'x-api': itemsFromX,
  'html-list': itemsFromHtmlList,
};

/* ------------------------------------------------------------ dedupe/score */

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const tokenSet = (s) => new Set(normalize(s).split(' ').filter((w) => w.length > 2));

function similarity(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

function loadKnown() {
  const texts = [];
  for (const dir of [QUOTES_DIR, CANDIDATES_DIR]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const record = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        if (record.text) texts.push({ id: file.replace(/\.json$/, ''), text: record.text });
      } catch {
        /* scratch files are none of our business */
      }
    }
  }
  return texts;
}

const candidateId = (text) => createHash('sha1').update(normalize(text)).digest('hex').slice(0, 12);

/* -------------------------------------------------------------------- main */

if (args.includes('--list')) {
  for (const source of CONFIG.sources) {
    const gate = source.requiresEnv ? (process.env[source.requiresEnv] ? 'env set' : `needs ${source.requiresEnv}`) : 'no auth';
    console.log(`${source.enabled ? 'on ' : 'off'}  ${source.id.padEnd(18)} ${source.kind.padEnd(12)} ${gate.padEnd(18)} ${source.label}`);
  }
  process.exit(0);
}

const summary = { ranAt: new Date().toISOString(), sources: [], checked: 0, candidates: 0, duplicates: 0, errors: [] };
mkdirSync(CANDIDATES_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

const known = loadKnown();
const enabled = CONFIG.sources.filter((s) => (ONLY ? s.id === ONLY : s.enabled));
if (!enabled.length) {
  console.log(ONLY ? `--source=${ONLY} matched no source.` : 'No sources enabled.');
  process.exit(0);
}

let written = 0;
const perSource = new Map();

for (const source of enabled) {
  summary.sources.push(source.id);
  console.log(`\n${source.label}  [${source.id}]`);
  const adapter = ADAPTERS[source.kind];
  const extractor = EXTRACTORS[source.extract];
  if (!adapter || !extractor) {
    summary.errors.push(`${source.id}: unknown kind/extractor (${source.kind}/${source.extract})`);
    console.log('  ! unknown kind or extractor');
    continue;
  }

  let items = [];
  try {
    items = await adapter(source);
  } catch (err) {
    summary.errors.push(`${source.id}: ${err.message}`);
    console.log(`  ! skipped: ${err.message}`);
    continue;
  }

  const quota = Math.max(1, Math.ceil(LIMIT / enabled.length));
  let handled = 0;
  for (const item of items.slice(0, quota)) {
    handled++;
    summary.checked++;
    try {
      let text = item.body ?? '';
      // News feeds carry only a summary: follow the link to the article itself.
      if (source.extract === 'sentence-quote' && item.url) {
        const res = await politeFetch(item.url, { kind: 'html' });
        text = htmlToText(await res.text());
      }
      const found = extractor(source.extract === 'meme-quote' ? `${item.title} ${text}` : text);
      for (const hit of found) {
        const id = candidateId(hit.text);
        if (perSource.has(id)) continue;
        const clash = known.find((k) => similarity(k.text, hit.text) >= CONFIG.duplicateThreshold);
        if (clash) {
          summary.duplicates++;
          console.log(`  = duplicate of ${clash.id}`);
          continue;
        }
        perSource.set(id, true);

        const isMeme = source.extract === 'meme-quote';
        const isPost = source.extract === 'post';
        const today = new Date().toISOString().slice(0, 10);
        const candidate = {
          id,
          text: hit.text,
          speaker: 'Donald Trump',
          spokenOn: isPost ? item.publishedAt : null, // a post has a publication date; a report's date is not when he said it
          context: isPost ? `${source.id === 'x-trump' ? 'X post' : 'Truth Social post'}${item.publishedAt ? `, ${item.publishedAt}` : ''}` : item.title || null,
          tags: [...(isPost ? ['from-post'] : isMeme ? ['from-meme'] : ['from-news']), ...tagsFor(hit.text)],
          sources: [
            {
              label: `${source.label} — ${(item.title || item.url).slice(0, 150)}`.slice(0, 190),
              url: item.url,
              type: source.sourceType,
              accessedAt: today,
              excerpt: hit.evidence.slice(0, 400),
            },
          ],
          confidence: isMeme ? 'widely-reported' : source.sourceType === 'primary' ? 'primary' : 'secondary',
          status: 'candidate',
          addedAt: today,
          addedBy: `ingest:${source.id}`,
          notes: isMeme
            ? 'Found circulating as a meme. Circulation is not evidence: needs a second, non-meme source before it can be published.'
            : isPost
              ? 'His own words as published, archived at the link. Check the surrounding post before approving.'
              : 'Sentence as the article printed it — a report quoting him, not a transcript.',
          evidence: {
            method: source.extract,
            articleTitle: item.title || null,
            articlePublishedAt: item.publishedAt ?? null,
            fetchedAt: new Date().toISOString(),
            surroundingText: hit.evidence.slice(0, 600),
          },
        };
        if (DRY_RUN) {
          console.log(`  ~ (dry) ${hit.text.slice(0, 72)}…`);
        } else {
          writeFileSync(join(CANDIDATES_DIR, `${id}.json`), `${JSON.stringify(candidate, null, 2)}\n`);
          console.log(`  + ${hit.text.slice(0, 72)}…`);
        }
        written++;
      }
    } catch (err) {
      console.log(`  ! ${item.url}: ${err.message}`);
      summary.errors.push(`${source.id} ${item.url}: ${err.message}`);
    }
  }
  console.log(`  checked ${handled} item(s), ${perSource.size} new candidate(s)`);
}

summary.candidates = written;
if (!DRY_RUN) {
  writeFileSync(join(LOG_DIR, 'last-run.json'), `${JSON.stringify(summary, null, 2)}\n`);
  mkdirSync(join(LOG_DIR, 'runs'), { recursive: true });
  writeFileSync(join(LOG_DIR, 'runs', `${Date.now()}.json`), `${JSON.stringify(summary, null, 2)}\n`);
}

console.log(`\n${written} candidate(s) in data/candidates/ · ${summary.duplicates} duplicate(s) skipped · ${summary.errors.length} source error(s)`);
if (written) console.log('Review and publish:  npm run dash');
if (summary.errors.length) console.log(summary.errors.map((e) => `  ${e}`).join('\n'));