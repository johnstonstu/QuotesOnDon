#!/usr/bin/env node
/**
 * Generates the dispatch packets from docs/roadmap/tasks.json, so the task list has one
 * source of truth and the hand-off format is reproducible:
 *
 *   node tools/make-packets.mjs            # writes docs/roadmap/packets/<task-id>.json
 *   node tools/make-packets.mjs --check    # fails if the packets are out of date
 *
 * The packets are shaped for a bounded, single-worker dispatch: one task, one branch,
 * one file, one acceptance command, no merge. `engine`, `model` and the budget are
 * declared as unpinned on purpose — those are the coordinator's call and are never set
 * by a research task itself.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = join(ROOT, 'docs/roadmap/tasks.json');
const OUT = join(ROOT, 'docs/roadmap/packets');
const CHECK = process.argv.includes('--check');

const spec = JSON.parse(readFileSync(TASKS, 'utf8'));

function packetFor(task) {
  const deliverable = task.deliverable;
  return {
    task_id: task.task_id,
    base: spec.base,
    title: task.title,
    question: task.question,
    why: task.why,
    allowed_paths: spec.defaults.allowed_paths,
    excluded_paths: spec.defaults.excluded_paths,
    deliverable,
    acceptance_command: `node tools/check-research.mjs ${deliverable}`,
    must_include: task.must_include,
    boundaries: [...spec.defaults.boundaries ?? [], ...(task.boundaries ?? [])],
    engine: 'coordinator-choice',
    model: 'coordinator-choice',
    bounds: spec.defaults.bounds,
    commit_instruction: spec.defaults.commit_instruction,
    report_requirements: 'See research/README.md — six required sections, every finding backed by a fetched URL.',
  };
}

const packets = spec.tasks.map(packetFor);

if (CHECK) {
  const existing = existsSync(OUT) ? readdirSync(OUT).filter((f) => f.endsWith('.json')).sort() : [];
  const expected = packets.map((p) => `${p.task_id}.json`).sort();
  if (JSON.stringify(existing) !== JSON.stringify(expected)) {
    console.error(`packets out of date: have ${existing.length}, need ${expected.length}. Run node tools/make-packets.mjs`);
    process.exit(1);
  }
  for (const p of packets) {
    const onDisk = readFileSync(join(OUT, `${p.task_id}.json`), 'utf8');
    if (JSON.parse(onDisk).task_id !== p.task_id) {
      console.error(`${p.task_id}.json does not match tasks.json — run node tools/make-packets.mjs`);
      process.exit(1);
    }
  }
  console.log(`packets: ${packets.length} up to date`);
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
for (const file of existsSync(OUT) ? readdirSync(OUT).filter((f) => f.endsWith('.json')) : []) {
  if (!packets.some((p) => `${p.task_id}.json` === file)) rmSync(join(OUT, file));
}
for (const packet of packets) {
  writeFileSync(join(OUT, `${packet.task_id}.json`), `${JSON.stringify(packet, null, 2)}\n`);
}
console.log(`wrote ${packets.length} packet(s) to docs/roadmap/packets/`);
for (const packet of packets) console.log(`  ${packet.task_id.padEnd(26)} → ${packet.deliverable}`);