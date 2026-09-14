#!/usr/bin/env node
/**
 * Resolves an X/Twitter post to its verbatim text, with no auth, so a quote can be
 * published from X without trusting anybody's paraphrase of it.
 *
 *   node tools/x-verify.mjs https://x.com/realDonaldTrump/status/2082159711852298494
 *   node tools/x-verify.mjs 2082159711852298494
 *
 * Why this exists: an LLM (Grok, or any model) reading X can tell you which post
 * exists, but its rendering of the words is a paraphrase and therefore not a source.
 * This step fetches the actual post text from a public mirror and is the only place
 * the pipeline takes text from. If it cannot resolve a post, the candidate is dropped.
 *
 * Prints JSON on stdout (text, id, url, author, createdAt) and exits non-zero when
 * the post cannot be resolved verbatim.
 */
import { existsSync } from 'node:fs';

const MIRROR = process.env.X_MIRROR_BASE || 'https://api.fxtwitter.com';
const UA = 'QuotesOnDonBot/0.1 (+https://github.com/johnstonstu/QuotesOnDon)';

for (const envFile of ['.env', `${process.env.HOME ?? ''}/.hermes/.env`]) {
  try {
    if (existsSync(new URL(`../${envFile}`, import.meta.url))) process.loadEnvFile(new URL(`../${envFile}`, import.meta.url));
  } catch {
    /* ignore */
  }
}

export function postIdFrom(input) {
  const value = String(input ?? '').trim();
  if (/^\d{15,25}$/.test(value)) return value;
  const match = value.match(/status(?:es)?\/(\d{15,25})/);
  return match ? match[1] : null;
}

/**
 * Pulls every X post reference out of a blob of text (a pasted Telegram message, a
 * screenshot's OCR, a Grok answer). Accepts x.com/twitter.com status URLs with or
 * without a scheme, and bare post ids. Returns one entry per unique post, in the
 * order they appear. Anything it cannot identify is ignored rather than guessed at.
 */
export function extractPostRefs(text) {
  const source = String(text ?? '');
  const hits = [];
  const urlSpans = [];

  // URLs: (x|twitter).com/<user>/status/<id> — the username may be absent (i/web links)
  for (const match of source.matchAll(
    /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:([A-Za-z0-9_]{1,20})\/)?status(?:es)?\/(\d{15,25})/g,
  )) {
    // "i" and "web" are X's generic path segments, not usernames.
    const user = match[1] && !['i', 'web'].includes(match[1].toLowerCase()) ? match[1] : null;
    hits.push({ index: match.index ?? 0, id: match[2], user });
    urlSpans.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }

  // Bare ids, but only standalone ones outside a URL — never carve a post id out of
  // a longer number, and never re-read one we already took from a URL.
  for (const match of source.matchAll(/(?<!\d)(\d{15,25})(?!\d)/g)) {
    const index = match.index ?? 0;
    if (urlSpans.some(([start, end]) => index >= start && index < end)) continue;
    hits.push({ index, id: match[1], user: null });
  }

  return hits
    .sort((a, b) => a.index - b.index)
    .filter((hit, i, all) => all.findIndex((h) => h.id === hit.id) === i)
    .map((hit) => ({ id: hit.id, user: hit.user, url: `https://x.com/${hit.user ?? 'i'}/status/${hit.id}` }));
}

export async function verifyPost(input) {
  const id = postIdFrom(input);
  if (!id) throw new Error(`not a post id or x.com/…/status/<id> URL: ${input}`);

  const res = await fetch(`${MIRROR}/status/${id}`, {
    headers: { accept: 'application/json', 'user-agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`mirror returned HTTP ${res.status} for ${id}`);
  const body = await res.json();
  const tweet = body?.tweet;
  if (!tweet?.text) throw new Error(`mirror returned no text for ${id} (code ${body?.code ?? '?'})`);

  return {
    id: tweet.id ?? id,
    text: tweet.text,
    url: tweet.url ?? `https://x.com/i/status/${id}`,
    author: tweet.author?.screen_name ? `@${tweet.author.screen_name}` : null,
    authorName: tweet.author?.name ?? null,
    createdAt: tweet.created_at ? new Date(tweet.created_at).toISOString().slice(0, 10) : null,
    isReply: Boolean(tweet.replying_to),
    verifiedBy: `${new URL(MIRROR).hostname} (post ${id})`,
    fetchedAt: new Date().toISOString(),
  };
}

// CLI use
if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: node tools/x-verify.mjs <x.com status URL or post id>');
    process.exit(2);
  }
  try {
    const post = await verifyPost(input);
    console.log(JSON.stringify(post, null, 2));
  } catch (err) {
    console.error(`could not verify: ${err.message}`);
    process.exit(1);
  }
}