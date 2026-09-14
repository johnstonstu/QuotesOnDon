# Quotes on don

One random quote per visit, rebuilt from the 2018 WordPress theme as a static site — with the part
the original never had: **every quote carries the receipt**.

- **Site** — Astro, static output, no server, no database, no cookies, no analytics.
- **Store** — one JSON file per quote in `data/quotes/`, reviewed by a human before it lands.
- **X** — the bot finds the posts, `tools/x-verify.mjs` supplies the words, you approve them.
- **Pipeline** — `tools/ingest.mjs` proposes candidates from citable sources; `tools/dashboard.mjs`
  is where they get approved. Nothing publishes itself.
- **Honesty rules** — enforced by `tools/validate-quotes.mjs`, which the build runs first. A record
  without a source, or claiming a confidence it cannot back, fails the build.

The 2018 WordPress theme still exists, untouched, on the branch
[`legacy/wordpress-2018`](https://github.com/johnstonstu/QuotesOnDon/tree/legacy/wordpress-2018).

---

## Quickstart

```bash
npm install
npm run build      # validates the store, then builds dist/
npm run preview    # serve the build at http://localhost:4321

npm run dash       # review dashboard → http://127.0.0.1:8787
npm run ingest     # hunt for new candidates (writes to data/candidates/)
npm run data:check # validate the store only
npm test           # store rules + build freshness
```

## What is where

| Path | What it is |
| --- | --- |
| `data/quotes/<id>.json` | The published store. One quote per file. This is the source of truth. |
| `data/schema/quote.schema.json` | The record contract, including what "confidence" is allowed to mean. |
| `data/sources.json` | Ingest sources, ranked, with on/off switches and the reason for each. |
| `data/candidates/` | Scratch: candidates waiting for review (gitignored, plus `approved/` and `rejected/` history). |
| `data/ingest-log/` | One file per run: what was checked, what was written, what failed. |
| `src/lib/quotes.ts` | The only reader of the store; everything else goes through it. |
| `src/pages/` | `/` (random), `/quotes/` (search + tags), `/quotes/<id>/` (provenance), `/status/`, `/about/`, `/rss.xml`. |
| `tools/` | `ingest.mjs`, `dashboard.mjs`, `validate-quotes.mjs`, `x-verify.mjs`, `migrate-legacy-seed.mjs`. |
| `.github/workflows/` | `ci.yml` (validate + test + build), `deploy.yml` (GitHub Pages). |

## The quote record

```json
{
  "id": "fifth-avenue",
  "text": "I could stand in the middle of Fifth Avenue and shoot somebody and I wouldn't lose voters.",
  "speaker": "Donald Trump",
  "spokenOn": "2016-01-23",
  "context": "Campaign rally, Sioux Center, Iowa",
  "tags": ["campaign", "voters"],
  "sources": [
    { "label": "Wikipedia — Donald Trump", "url": "https://en.wikipedia.org/wiki/Donald_Trump",
      "type": "reference", "accessedAt": "2026-09-13", "excerpt": null }
  ],
  "confidence": "secondary",
  "status": "published",
  "addedAt": "2026-09-13",
  "addedBy": "migration:quotes_on_dev (2018 WordPress demo)",
  "notes": null
}
```

Rules that the validator and the tests enforce:

- `sources` is never empty and every URL is `http(s)`. No invented references.
- `confidence: "primary"` requires a source of `type: "primary"` — you cannot claim to hold a
  transcript you do not hold.
- `spokenOn` is the day the words were said, or `null`. The date an article was published is not
  the date he said it, so ingest never fills this in from a news feed.
- A quote tagged `from-meme` cannot be published until a second, **non-meme** source corroborates
  it: circulation is not evidence.
- `status: "retracted"` keeps the record for the audit trail but drops it from the site.

## The pipeline

```
  sources ──▶ candidates ──▶ [ human review ] ──▶ data/quotes/ ──▶ build ──▶ site
  (tools/ingest.mjs)        (npm run dash)                        (npm run build)
```

### Sources, ranked

| Rank | Source | Status | Why |
| --- | --- | --- | --- |
| 1 | **X — pasted finds** (`data/x-inbox.txt`) | **on, working** | No keys, no API tier. Whatever the Grok bot finds on X — forwarded from the phone, pasted, or OCR'd — is dropped in the inbox and resolved verbatim by `tools/x-verify.mjs`. |
| 1 | **X — @realDonaldTrump, via Grok** | **off, needs `XAI_API_KEY`** | Grok (xAI live search) is asked *which posts exist*; the words are then fetched verbatim by `tools/x-verify.mjs`. See "A quote from X" below. |
| 1 | **X — @realDonaldTrump, official API** | **off, needs `X_BEARER_TOKEN`** | Straight from X, no third party in the middle, but X's free tier cannot read another account's posts — this needs the paid Basic tier (~US$200/mo). |
| 1b | **Truth Social** (`trumpstruth.org/feed`) | **on, working** | His own posts, full text, a stable URL per post, no auth. Same words as the X feed in practice, since he cross-posts. Stands in while X discovery is dark. |
| 2 | NPR Politics, PBS NewsHour Politics | on, working | Reports quoting him. The article URL is the receipt; the extractor keeps the surrounding sentence as evidence. |
| 2 | GDELT DOC 2.0 | off by default | Global news search, `--source=gdelt`. Its free endpoint asks for at most one request every 5 seconds, so bursts get throttled. |
| 2 | American Presidency Project | off by default | Primary transcripts, `--source=presidency-ucsb`. Its robots.txt sets `Crawl-delay: 10`, so a run takes minutes. |
| 3 | Reddit meme subs | **off, needs `REDDIT_CLIENT_ID`/`_SECRET`** | Meme circulation of a line. `reddit.com/robots.txt` disallows generic crawlers, so this uses Reddit's credentialed app API (free "script" app) rather than the feeds. Candidates arrive tagged `from-meme` and are blocked from publishing until a real source agrees. |

### A quote from X: discover, then verify

X is the source that matters most and the one hardest to reach honestly. Nitter mirrors are all behind
proof-of-work bot walls now, search engines no longer index `x.com/…/status/…` for automated queries,
and the official API cannot read another account on a free tier. So the X route is two steps:

1. **Discovery** — Grok (xAI live search, `sources: [{type:"x"}]`) or the official API returns the *URLs*
   of recent posts. The model is asked for URLs only: never for the wording.
2. **Verification** — `tools/x-verify.mjs` resolves each URL to the actual post text through a public
   mirror and records which mirror, which post id, and when. **The text in the store comes from this
   step, never from the model.** A post that cannot be resolved verbatim is dropped, not guessed at.

That boundary is the whole point: an LLM's rendering of a quote is a paraphrase, so it cannot be a
source. Check the route end to end with:

```bash
node tools/x-verify.mjs https://x.com/realDonaldTrump/status/<id>   # resolve one post verbatim
node tools/ingest.mjs --selftest=x-grok                              # confirm the xAI key + request shape
```

`--selftest` prints exactly what the adapter returned and writes nothing, so a key can be validated in
one command before a run is trusted.

**The route that needs no key at all** is the inbox: whatever the Grok bot finds on X goes into
`data/x-inbox.txt` — a whole forwarded message, a screenshot's text, or one URL per line:

```
https://x.com/realDonaldTrump/status/2082159711852298494
https://x.com/realDonaldTrump/status/2028505632123326484
```

```bash
npm run ingest -- --source=x-inbox     # resolve, write candidates, archive what it used
```

Every reference in the file is parsed out (URLs, bare post ids, `/i/` links), resolved to its verbatim
text through the verifier, and turned into a candidate whose evidence records both the discovery route
and the verifier that supplied the words. Resolved lines move to `data/x-inbox.processed.txt`; lines that
could not be resolved **stay in the inbox** with the reason appended, so a bad link gets fixed instead of
silently lost. Lines the parser cannot recognise as a post reference are left alone too.

An alternative that needs no API key at all: ask Grok *in the app on your phone* (where it already reads
X on your account) to forward recent posts to your Telegram bot, and have the pipeline read that channel
and verify every link the same way. Same rule applies — the link is the claim, the mirror is the evidence.

Ingest respects `robots.txt` (including `Crawl-delay`), spaces requests per host, caps pages per run,
and refuses to touch a host that disallows the bot. Credentials come from `.env` (gitignored) or
`~/.hermes/.env`; nothing is committed. See `.env.example` for the three keys (`XAI_API_KEY`,
`X_BEARER_TOKEN`, `REDDIT_CLIENT_ID`/`_SECRET`).

### The dashboard

`npm run dash` serves a local-only review page on `127.0.0.1:8787`:

- candidates with the quoted words, the source link, and the surrounding sentence the extractor saw;
- **Approve & publish** (runs the validator, rolls itself back if the record would break the build),
  **Reject**, and **Retract** for anything already published;
- buttons for *Run ingest*, *Validate store*, *Rebuild the site*, and *git status*.

It never commits. It shows you `git status` so the commit stays your decision.

## Deploy

`deploy.yml` builds and publishes to GitHub Pages on every push to `main`. `public/CNAME` already
points at `quotesondon.com`, so the remaining steps are one-time, in the repo and at the registrar:

1. **Repo → Settings → Pages → Source: GitHub Actions.**
2. **DNS at the registrar** (quotesondon.com is on Google/Squarespace nameservers — `ns-cloud-a*.googledomains.com`):
   four `A` records for the apex → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
   `185.199.111.153`, and a `CNAME` for `www` → `johnstonstu.github.io`.
3. Wait for the certificate, then tick **Enforce HTTPS**.

## Local notes

- No secrets, no database. The only file the site reads at build time is `data/quotes/`.
- The `/status/` page is generated from the store, so it cannot drift from reality.
- Everything is static: the random rotation and search run in the browser off a small
  `/quotes-index.json`.

## Credits

Built by [Johnstonstu](https://github.com/johnstonstu) — originally at RED Academy in 2018
(WordPress, CMB2, the WP REST API), rebuilt in 2026. Not affiliated with, endorsed by or connected
to Donald Trump or any organisation of his. MIT licensed; see `LICENSE` for the note on the quotes.