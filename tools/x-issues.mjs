#!/usr/bin/env node
/**
 * The Grok Bot handoff.
 *
 * A Grok Bot can browse X on your account and find posts. It cannot see this
 * checkout, and it should never hand over the wording of a quote — only which posts
 * exist. So the transport is a GitHub issue: the Bot opens an issue labelled
 * `x-inbox` with post URLs; this module reads the open issues, resolves every
 * reference to its verbatim text through tools/x-verify.mjs, hands candidates back
 * to the ingest run, then comments the outcome on the issue and closes it.
 *
 * The Bot's message is a claim. The verifier supplies the words. That split is the
 * whole reason this is safe to automate.
 *
 * Requires the `gh` CLI, authenticated.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyPost, extractPostRefs } from './x-verify.mjs';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, 'data/x-issues.processed.json');
export const INBOX_LABEL = 'x-inbox';
const DONE_LABEL = 'ingested';

function gh(args) {
  return run('gh', args, { cwd: ROOT, maxBuffer: 8 * 1024 * 1024, env: process.env });
}

export async function ghAvailable() {
  try {
    await gh(['auth', 'status']);
    return true;
  } catch {
    return false;
  }
}

function loadState() {
  if (!existsSync(STATE)) return { issues: {} };
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return { issues: {} };
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
}

async function openIssues() {
  const { stdout } = await gh([
    'issue',
    'list',
    '--label',
    INBOX_LABEL,
    '--state',
    'open',
    '--limit',
    '20',
    '--json',
    'number,title,body,url',
  ]);
  return JSON.parse(stdout || '[]');
}

export async function itemsFromXIssues({ verify = verifyPost, log = console.log } = {}) {
  if (!(await ghAvailable())) {
    throw new Error(
      'gh CLI is not authenticated — the Grok Bot handoff needs it. Run `gh auth status` to see why, or use data/x-inbox.txt instead.',
    );
  }

  const issues = await openIssues();
  if (!issues.length) {
    log(`  no open issues labelled ${INBOX_LABEL}`);
    return [];
  }

  const state = loadState();
  const items = [];

  for (const issue of issues) {
    const previous = state.issues[issue.number];
    if (previous?.urls?.length && previous.closed) {
      log(`  #${issue.number} already ingested, skipping`);
      continue;
    }

    const refs = extractPostRefs(`${issue.title ?? ''}\n${issue.body ?? ''}`);
    log(`  #${issue.number} "${String(issue.title).slice(0, 60)}" — ${refs.length} post reference(s)`);
    if (!refs.length) {
      await gh([
        'issue',
        'comment',
        String(issue.number),
        '--body',
        'No X post references found in this issue. Nothing was ingested — the pipeline needs URLs of the form https://x.com/<user>/status/<id>.',
      ]);
      continue;
    }

    const resolved = [];
    const failed = [];
    for (const ref of refs) {
      try {
        const post = await verify(ref.url);
        if (!post.text) throw new Error('mirror returned no text');
        items.push({
          title: `X post by ${post.author ?? ref.user ?? 'unknown'}`,
          url: post.url,
          publishedAt: post.createdAt,
          body: post.text, // verbatim, from the verifier — never the Bot's rendering
          verifiedBy: post.verifiedBy,
          discovery: `github issue #${issue.number} (Grok Bot handoff)`,
        });
        resolved.push(`| ${post.createdAt ?? '—'} | ${post.text.slice(0, 80).replace(/\|/g, '\\|')}… | ${post.url} |`);
      } catch (err) {
        failed.push(`- ${ref.url} — ${err.message}`);
        log(`  ! ${ref.url}: ${err.message}`);
      }
    }

    const body = [
      `Ingest ran on this issue: **${resolved.length} resolved, ${failed.length} not**.`,
      '',
      resolved.length
        ? ['| Posted | Quote (verbatim, from the verifier) | Post |', '| --- | --- | --- |', ...resolved].join('\n')
        : '_Nothing resolved._',
      failed.length ? `\nCould not verify:\n${failed.join('\n')}` : '',
      '',
      resolved.length
        ? `${resolved.length} candidate(s) are waiting in the review dashboard (\`npm run dash\`). Nothing is published until they are approved there.`
        : 'No candidates were written.',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      await gh(['issue', 'comment', String(issue.number), '--body', body]);
      await gh(['issue', 'edit', String(issue.number), '--add-label', DONE_LABEL]);
      if (!failed.length) {
        await gh(['issue', 'close', String(issue.number), '--reason', 'completed']);
        log(`  #${issue.number} closed (all references resolved)`);
      } else {
        log(`  #${issue.number} left open — ${failed.length} reference(s) could not be resolved`);
      }
      state.issues[issue.number] = {
        urls: refs.map((r) => r.url),
        resolved: resolved.length,
        failed: failed.length,
        closed: failed.length === 0,
        ranAt: new Date().toISOString(),
      };
    } catch (err) {
      log(`  ! could not update #${issue.number}: ${err.message}`);
    }
  }

  if (!process.env.DRY_RUN) saveState(state);
  return items;
}

/** Creates the labels the handoff relies on, if they are missing. Idempotent. */
export async function ensureLabels({ repo } = {}) {
  for (const [name, description, color] of [
    [INBOX_LABEL, 'Grok Bot handoff: X post URLs awaiting ingest', 'ff7a18'],
    [DONE_LABEL, 'Ingested into the quote pipeline', '4ade80'],
  ]) {
    try {
      await gh(['label', 'create', name, '--description', description, '--color', color, '--force', ...(repo ? ['--repo', repo] : [])]);
    } catch (err) {
      // A label that already exists is fine; anything else is worth knowing about.
      if (!/already exists/i.test(String(err.stderr ?? err.message))) throw err;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { stdout } = await run('git', ['config', '--get', 'remote.origin.url'], { cwd: ROOT }).catch(() => ({ stdout: '' }));
  await ensureLabels();
  const items = await itemsFromXIssues();
  console.log(`\n${items.length} item(s) ready to become candidates`);
  console.log(`remote: ${String(stdout).trim() || 'unknown'}`);
}