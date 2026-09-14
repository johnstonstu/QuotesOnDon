#!/usr/bin/env node
/**
 * One-off migration: turns the 12 posts seeded into the 2018 WordPress demo into
 * versioned quote records. Kept in the repo because it documents exactly where the
 * seed set came from and what claim each row carries.
 *
 * Run: node tools/migrate-legacy-seed.mjs
 *
 * Confidence is recorded honestly: nothing here is a located primary source, so
 * nothing claims to be. The site renders the caution label accordingly.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data/quotes');
const ADDED_AT = '2026-09-13';
const ADDED_BY = 'migration:quotes_on_dev (2018 WordPress demo)';

const WIKI = (page, label) => ({ label, url: `https://en.wikipedia.org/wiki/${page}`, type: 'reference', accessedAt: ADDED_AT, excerpt: null });

const quotes = [
  {
    id: 'build-a-great-great-wall',
    text: 'I will build a great, great wall on our southern border. And I will have Mexico pay for that wall.',
    spokenOn: '2015-06-16',
    context: 'Announcement speech, Trump Tower, New York',
    tags: ['immigration', 'campaign'],
    confidence: 'secondary',
    sources: [WIKI('Donald_Trump_2016_presidential_campaign', 'Wikipedia — Donald Trump 2016 presidential campaign')],
  },
  {
    id: 'make-america-great-again',
    text: 'Make America Great Again.',
    spokenOn: null,
    context: 'Campaign slogan, 2016 presidential campaign',
    tags: ['campaign', 'slogan'],
    confidence: 'secondary',
    sources: [WIKI('Make_America_Great_Again', 'Wikipedia — Make America Great Again')],
  },
  {
    id: 'fifth-avenue',
    text: "I could stand in the middle of Fifth Avenue and shoot somebody and I wouldn't lose voters.",
    spokenOn: '2016-01-23',
    context: 'Campaign rally, Sioux Center, Iowa',
    tags: ['campaign', 'voters'],
    confidence: 'secondary',
    sources: [WIKI('Donald_Trump', 'Wikipedia — Donald Trump')],
  },
  {
    id: 'youre-fired',
    text: "You're fired.",
    spokenOn: null,
    context: 'The Apprentice (NBC), 2004–2015',
    tags: ['television', 'catchphrase'],
    confidence: 'secondary',
    sources: [WIKI('The_Apprentice', 'Wikipedia — The Apprentice (American TV series)')],
  },
  {
    id: 'fake-news',
    text: 'Fake news.',
    spokenOn: null,
    context: 'Used at rallies and on Twitter from 2017',
    tags: ['media', 'social-media'],
    confidence: 'widely-reported',
    sources: [WIKI('Fake_news', 'Wikipedia — Fake news')],
  },
  {
    id: 'nobody-knows-more-about-taxes',
    text: 'Nobody knows more about taxes than I do.',
    spokenOn: null,
    context: 'Interview',
    tags: ['taxes', 'television'],
    confidence: 'widely-reported',
    sources: [WIKI('Donald_Trump', 'Wikipedia — Donald Trump')],
  },
  {
    id: 'sad',
    text: 'Sad!',
    spokenOn: null,
    context: 'Twitter sign-off',
    tags: ['social-media', 'catchphrase'],
    confidence: 'widely-reported',
    sources: [WIKI('Donald_Trump_on_social_media', 'Wikipedia — Donald Trump on social media')],
  },
  {
    id: 'big-league',
    text: 'Big league.',
    spokenOn: null,
    context: 'Rally staple, frequently misheard as “bigly”',
    tags: ['campaign', 'catchphrase'],
    confidence: 'widely-reported',
    sources: [WIKI('Bigly', 'Wikipedia — Bigly')],
  },
  {
    id: 'least-racist-person',
    text: 'I am the least racist person you have ever interviewed.',
    spokenOn: '2018-01-14',
    context: 'Press availability, Palm Beach, Florida',
    tags: ['race', 'press'],
    confidence: 'widely-reported',
    sources: [WIKI('Donald_Trump', 'Wikipedia — Donald Trump')],
  },
  {
    id: 'bored-with-winning',
    text: "We're going to have so much winning that you may get bored with winning.",
    spokenOn: null,
    context: 'Campaign rally',
    tags: ['campaign'],
    confidence: 'widely-reported',
    sources: [WIKI('Donald_Trump_2016_presidential_campaign', 'Wikipedia — Donald Trump 2016 presidential campaign')],
  },
  {
    id: 'total-disaster',
    text: "It's going to be huge. And by the way, a total disaster for them.",
    spokenOn: null,
    context: 'Campaign rally',
    tags: ['campaign'],
    confidence: 'widely-reported',
    sources: [WIKI('Donald_Trump', 'Wikipedia — Donald Trump')],
    notes: 'Thin attribution — slated for replacement by a properly sourced ingest.',
  },
  {
    id: 'whats-on-the-internet',
    text: "All I know is what's on the internet.",
    spokenOn: null,
    context: 'Interview, 2016',
    tags: ['media', 'television'],
    confidence: 'widely-reported',
    sources: [WIKI('Donald_Trump', 'Wikipedia — Donald Trump')],
  },
];

mkdirSync(OUT, { recursive: true });
let written = 0;
for (const q of quotes) {
  const record = {
    ...q,
    speaker: q.speaker ?? 'Donald Trump',
    context: q.context ?? null,
    notes: q.notes ?? null,
    status: 'published',
    addedAt: ADDED_AT,
    addedBy: ADDED_BY,
  };
  const file = join(OUT, `${q.id}.json`);
  if (existsSync(file)) {
    console.log(`skip  ${q.id} (exists)`);
    continue;
  }
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  written++;
}
console.log(`wrote ${written} quote record(s) to data/quotes/`);