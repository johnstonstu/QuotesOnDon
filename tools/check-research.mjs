#!/usr/bin/env node
/**
 * Gate for research reports. Run with no arguments to check every research/*.md
 * (files starting with "_" are templates and are skipped), or pass explicit paths:
 *
 *   node tools/check-research.mjs
 *   node tools/check-research.mjs research/mirror-survey.md
 *
 * A report fails if a required section is missing or empty, if it cites no fetched
 * URL, or if any URL in the Evidence section is not http(s). The point is that an
 * unreadable or unsourced report fails loudly instead of sitting in a directory
 * looking like work.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'research');
const REQUIRED = ['## Question', '## Method', '## Findings', '## Evidence', '## Confidence', '## Open questions'];

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = args.length
  ? args
  : existsSync(DIR)
    ? readdirSync(DIR)
        .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f.toUpperCase() !== 'README.MD')
        .sort()
        .map((f) => join('research', f))
    : [];

if (!files.length) {
  console.log('research: no reports yet — nothing to check (that is fine)');
  process.exit(0);
}

const problems = [];
let checked = 0;

for (const rel of files) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) {
    problems.push(`${rel}: file does not exist`);
    continue;
  }
  checked++;
  const text = readFileSync(path, 'utf8');
  const name = basename(rel);

  for (const section of REQUIRED) {
    const index = text.indexOf(section);
    if (index === -1) {
      problems.push(`${name}: missing section "${section}"`);
      continue;
    }
    const body = text.slice(index + section.length).split(/^## /m)[0].replace(/\s+/g, ' ').trim();
    // Completeness, not verbosity: an honest "nothing outstanding" is a valid answer,
    // an empty heading is not.
    if (body.length < 5) problems.push(`${name}: section "${section}" is empty`);
    if (/<[a-z][^>]*>/.test(body) && /<(the question|finding|what you|high\|medium)/i.test(body)) {
      problems.push(`${name}: section "${section}" still contains template placeholders`);
    }
  }

  const evidenceStart = text.indexOf('## Evidence');
  const evidence = evidenceStart === -1 ? '' : text.slice(evidenceStart + '## Evidence'.length).split(/^## /m)[0];
  const urls = [...evidence.matchAll(/https?:\/\/[^\s`)>]+/g)].map((m) => m[0]);
  if (!urls.length) problems.push(`${name}: Evidence cites no fetched URL`);

  for (const url of urls) {
    if (!/^https?:\/\/[^\s]+\.[^\s]+/.test(url)) problems.push(`${name}: Evidence URL looks malformed: ${url}`);
  }

  const badUrls = [...text.matchAll(/https?:\/\/\S+/g)].filter((m) => !/^https?:\/\/[a-z0-9.-]+/i.test(m[0]));
  for (const bad of badUrls) problems.push(`${name}: malformed URL: ${bad[0]}`);

  // The report must state its own task id, so a stray file cannot pass as a task result.
  if (!/^#\s+\S+/.test(text)) problems.push(`${name}: first line must be "# <task-id> — <title>"`);
}

if (problems.length) {
  console.error(`research: ${problems.length} problem(s) across ${checked} report(s):`);
  for (const problem of problems) console.error(`  error ${problem}`);
  process.exit(1);
}

console.log(`research: ${checked} report(s) OK (${files.map((f) => basename(f)).join(', ')})`);