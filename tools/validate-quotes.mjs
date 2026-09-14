#!/usr/bin/env node
/**
 * Validates every quote in data/quotes against data/schema/quote.schema.json
 * plus the cross-record rules the schema can't express. Exits non-zero on any
 * problem, so `npm run build` refuses to publish a broken or unsourced quote.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUOTES_DIR = join(ROOT, 'data/quotes');
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'data/schema/quote.schema.json'), 'utf8'));

const errors = [];
const warn = [];

function typeOk(value, spec) {
  switch (spec.type) {
    case 'string': return typeof value === 'string';
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null': return value === null;
    default: return true;
  }
}

function check(value, spec, path) {
  const types = Array.isArray(spec.type) ? spec.type : spec.type ? [spec.type] : [];
  if (types.length && !types.some((t) => typeOk(value, { type: t }))) {
    errors.push(`${path}: expected ${types.join('|')}, got ${JSON.stringify(value)?.slice(0, 40)}`);
    return;
  }
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (spec.minLength && value.length < spec.minLength) errors.push(`${path}: shorter than ${spec.minLength}`);
    if (spec.maxLength && value.length > spec.maxLength) errors.push(`${path}: longer than ${spec.maxLength} (${value.length})`);
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) errors.push(`${path}: does not match ${spec.pattern}`);
    if (spec.enum && !spec.enum.includes(value)) errors.push(`${path}: "${value}" not in ${spec.enum.join('|')}`);
  }
  if (Array.isArray(value)) {
    if (spec.minItems && value.length < spec.minItems) errors.push(`${path}: needs at least ${spec.minItems} item(s)`);
    if (spec.maxItems && value.length > spec.maxItems) errors.push(`${path}: at most ${spec.maxItems} items`);
    if (spec.items) value.forEach((v, i) => check(v, spec.items, `${path}[${i}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of spec.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required "${key}"`);
    }
    if (spec.additionalProperties === false && spec.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in spec.properties)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
    for (const [key, child] of Object.entries(spec.properties ?? {})) {
      if (key in value) check(value[key], child, `${path}.${key}`);
    }
  }
}

const files = readdirSync(QUOTES_DIR).filter((f) => f.endsWith('.json'));
if (files.length === 0) errors.push('data/quotes: no quotes found');

const seen = new Map();
const seenText = new Map();

for (const file of files) {
  const path = `data/quotes/${file}`;
  let quote;
  try {
    quote = JSON.parse(readFileSync(join(QUOTES_DIR, file), 'utf8'));
  } catch (err) {
    errors.push(`${path}: invalid JSON (${err.message})`);
    continue;
  }
  check(quote, SCHEMA, path);

  if (quote.id && `${quote.id}.json` !== file) errors.push(`${path}: id "${quote.id}" must match the filename`);
  if (seen.has(quote.id)) errors.push(`${path}: duplicate id, also in ${seen.get(quote.id)}`);
  seen.set(quote.id, file);

  const key = String(quote.text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (key) {
    if (seenText.has(key)) errors.push(`${path}: duplicate quote text, also in ${seenText.get(key)}`);
    seenText.set(key, file);
  }

  if (quote.confidence === 'primary' && !((quote.sources ?? []).some((s) => s.type === 'primary'))) {
    errors.push(`${path}: confidence "primary" needs a source of type "primary"`);
  }
  if (quote.confidence === 'widely-reported') {
    warn.push(`${path}: no located primary source — shown with a caution label on the site`);
  }
  for (const [i, source] of (quote.sources ?? []).entries()) {
    if (source.url && !/^https?:\/\//.test(source.url)) errors.push(`${path}.sources[${i}].url: not http(s)`);
  }
  if (quote.status === 'draft' && files.length && file.startsWith('draft-')) {
    warn.push(`${path}: draft kept in data/quotes`);
  }
}

const byConfidence = {};
for (const file of files) {
  const q = JSON.parse(readFileSync(join(QUOTES_DIR, file), 'utf8'));
  byConfidence[q.confidence] = (byConfidence[q.confidence] ?? 0) + 1;
}

console.log(`quotes: ${files.length} · ${Object.entries(byConfidence).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
for (const w of warn) console.warn(`  warn  ${w}`);

if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  error ${e}`);
  process.exit(1);
}