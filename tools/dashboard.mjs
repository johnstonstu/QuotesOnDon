#!/usr/bin/env node
/**
 * Local review dashboard for the quote pipeline. Binds 127.0.0.1 only.
 *
 *   npm run dash            → http://127.0.0.1:8787
 *
 * It is the only place a candidate becomes a published quote, and it enforces the
 * rule the site depends on: a quote tagged from-meme needs a second, non-meme
 * source before it can go out. Publishing runs the schema validator first and
 * rolls back if the record would break the build.
 *
 * No dependencies, no accounts: one reviewer, on this machine, writing only inside
 * data/ and touching git only to show status (it never commits).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUOTES_DIR = join(ROOT, 'data/quotes');
const CANDIDATES_DIR = join(ROOT, 'data/candidates');
const REJECTED_DIR = join(CANDIDATES_DIR, 'rejected');
const APPROVED_DIR = join(CANDIDATES_DIR, 'approved');
const LOG_DIR = join(ROOT, 'data/ingest-log');
const PORT = Number(process.env.DASH_PORT || 8787);

const readJson = (path, fallback = null) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
};
const listJson = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ file: f, data: readJson(join(dir, f)) }))
        .filter((row) => row.data)
    : [];

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ------------------------------------------------------------- publishing */

function publish(candidate) {
  if (candidate.tags?.includes('from-meme')) {
    const corroborating = (candidate.sources ?? []).filter((s) => s.type !== 'reference');
    if (corroborating.length === 0) {
      return { ok: false, message: 'Blocked: a meme-sourced candidate needs a second, non-meme source before it can be published.' };
    }
  }
  const { evidence, ...quote } = candidate;
  const today = new Date().toISOString().slice(0, 10);
  const record = {
    ...quote,
    status: 'published',
    notes:
      [
        quote.notes,
        evidence ? `Ingest evidence (${evidence.method}, fetched ${evidence.fetchedAt}): ${evidence.surroundingText}` : null,
        `Approved via dashboard on ${today}`,
      ]
        .filter(Boolean)
        .join(' ')
        .slice(0, 600),
  };
  const target = join(QUOTES_DIR, `${candidate.id}.json`);
  if (existsSync(target)) return { ok: false, message: `A quote with id ${candidate.id} already exists.` };
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);
  return { ok: true, message: `Published ${candidate.id}`, target };
}

async function validate() {
  try {
    const { stdout } = await run('node', [join(ROOT, 'tools/validate-quotes.mjs')], { cwd: ROOT });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() };
  }
}

/* ------------------------------------------------------------------- view */

function render(message = null) {
  const quotes = listJson(QUOTES_DIR);
  const candidates = listJson(CANDIDATES_DIR);
  const rejected = listJson(REJECTED_DIR);
  const lastRun = readJson(join(LOG_DIR, 'last-run.json'));
  const bySource = {};
  for (const q of quotes) bySource[q.data.addedBy] = (bySource[q.data.addedBy] ?? 0) + 1;
  const memePending = candidates.filter((c) => c.data.tags?.includes('from-meme')).length;

  const candidateCards = candidates
    .sort((a, b) => (b.data.addedAt ?? '').localeCompare(a.data.addedAt ?? ''))
    .map(({ file, data }) => {
      const src = data.sources?.[0];
      const blocked = data.tags?.includes('from-meme');
      return `
      <article class="cand">
        <p class="text">${escapeHtml(data.text)}</p>
        <p class="meta">
          <span class="badge ${escapeHtml(data.confidence)}">${escapeHtml(data.confidence)}</span>
          <span class="tag">${escapeHtml((data.tags ?? []).join(' · '))}</span>
          <span class="src">from <a href="${escapeHtml(src?.url ?? '#')}" target="_blank" rel="noopener">${escapeHtml(src?.label ?? 'no source')}</a></span>
        </p>
        ${data.evidence?.surroundingText ? `<p class="evidence">${escapeHtml(data.evidence.surroundingText)}</p>` : ''}
        <p class="meta">
          <span class="dim">${escapeHtml(data.addedBy)} · fetched ${escapeHtml(data.evidence?.fetchedAt ?? '?')}${data.spokenOn ? ` · posted ${escapeHtml(data.spokenOn)}` : ''}</span>
        </p>
        <form method="post" class="actions">
          <input type="hidden" name="id" value="${escapeHtml(data.id)}">
          <button name="action" value="approve" ${blocked ? 'title="needs a second source first"' : ''}>Approve &amp; publish</button>
          <button name="action" value="reject" class="ghost">Reject</button>
        </form>
      </article>`;
    })
    .join('');

  const quoteRows = quotes
    .sort((a, b) => (b.data.addedAt ?? '').localeCompare(a.data.addedAt ?? ''))
    .slice(0, 25)
    .map(
      ({ data }) => `
      <tr>
        <td>${escapeHtml(data.text.slice(0, 90))}${data.text.length > 90 ? '…' : ''}</td>
        <td><span class="badge ${escapeHtml(data.confidence)}">${escapeHtml(data.confidence)}</span></td>
        <td class="dim">${escapeHtml(data.addedBy ?? '')}</td>
        <td><form method="post"><input type="hidden" name="id" value="${escapeHtml(data.id)}"><button name="action" value="retract" class="ghost small">Retract</button></form></td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Quotes on don — pipeline</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 :root{--bg:#0a0a0b;--card:#141417;--border:#26262c;--text:#f4f4f5;--muted:#a1a1aa;--faint:#6b6b76;--accent:#ff7a18;--ok:#4ade80;--warn:#fbbf24}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif}
 .wrap{width:min(100% - 2.5rem,72rem);margin:0 auto;padding:2rem 0 4rem}
 h1{font-size:1.6rem;margin:0 0 .25rem} h2{font-size:1.05rem;margin:2rem 0 .75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
 a{color:var(--accent)} .dim{color:var(--faint);font-size:.82rem}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.75rem;margin:1.25rem 0}
 .stat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:.9rem 1rem}
 .stat .n{display:block;font-size:1.7rem;font-weight:700;line-height:1.1}
 .stat .k{color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}
 .bar{display:flex;gap:.5rem;flex-wrap:wrap;margin:1rem 0}
 button{font:inherit;background:transparent;color:var(--accent);border:1px solid rgba(255,122,24,.35);border-radius:999px;padding:.45rem 1rem;cursor:pointer}
 button:hover{background:rgba(255,122,24,.12)}
 button.ghost{color:var(--muted);border-color:var(--border)} button.small{padding:.25rem .7rem;font-size:.8rem}
 .cand{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1rem 1.1rem;margin-bottom:.75rem}
 .cand .text{margin:0 0 .5rem;font-size:1.02rem}
 .meta{margin:.25rem 0;color:var(--faint);font-size:.82rem;display:flex;gap:.75rem;flex-wrap:wrap;align-items:center}
 .evidence{margin:.5rem 0 0;padding-left:.7rem;border-left:2px solid rgba(255,122,24,.35);color:var(--muted);font:12px/1.5 ui-monospace,Menlo,monospace}
 .badge{border:1px solid var(--border);border-radius:999px;padding:.1rem .5rem;text-transform:uppercase;font-size:.68rem;letter-spacing:.04em}
 .badge.primary{color:var(--ok)} .badge.secondary{color:#7dd3fc} .badge.widely-reported{color:var(--warn)}
 table{width:100%;border-collapse:collapse;font-size:.9rem} td,th{text-align:left;padding:.5rem .4rem;border-bottom:1px solid var(--border);vertical-align:top}
 th{color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}
 .msg{background:var(--card);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:10px;padding:.75rem 1rem;margin:1rem 0;white-space:pre-wrap}
 .msg.bad{border-left-color:#f87171}
 pre{background:#101013;border:1px solid var(--border);border-radius:10px;padding:.8rem;overflow:auto;font-size:.8rem;color:var(--muted)}
</style></head>
<body><div class="wrap">
  <h1>Quotes on don — pipeline</h1>
  <p class="dim">Local only (127.0.0.1). This is the only door into <code>data/quotes/</code>.</p>

  ${message ? `<div class="msg ${message.ok ? '' : 'bad'}">${escapeHtml(message.text)}</div>` : ''}

  <div class="grid">
    <div class="stat"><span class="n">${quotes.length}</span><span class="k">published</span></div>
    <div class="stat"><span class="n">${candidates.length}</span><span class="k">awaiting review</span></div>
    <div class="stat"><span class="n">${memePending}</span><span class="k">meme-only (blocked)</span></div>
    <div class="stat"><span class="n">${rejected.length}</span><span class="k">rejected</span></div>
    <div class="stat"><span class="n">${lastRun ? escapeHtml(lastRun.ranAt.slice(0, 16).replace('T', ' ')) : '—'}</span><span class="k">last ingest</span></div>
  </div>

  <div class="bar">
    <form method="post"><button name="action" value="ingest">Run ingest now</button></form>
    <form method="post"><button name="action" value="validate" class="ghost">Validate store</button></form>
    <form method="post"><button name="action" value="build" class="ghost">Rebuild the site</button></form>
    <form method="post"><button name="action" value="gitstatus" class="ghost">git status</button></form>
  </div>

  <h2>Awaiting review (${candidates.length})</h2>
  ${candidateCards || '<p class="dim">Nothing waiting. Run an ingest.</p>'}

  <h2>Published (${quotes.length})</h2>
  <table><thead><tr><th>Quote</th><th>Confidence</th><th>Added by</th><th></th></tr></thead><tbody>${quoteRows}</tbody></table>

  <h2>How this works</h2>
  <p class="dim">Ingest proposes, a human approves, the build refuses unsourced records. Publishing here runs
  <code>tools/validate-quotes.mjs</code> and undoes itself if the record would break the build. The dashboard never commits — it shows
  <code>git status</code> so you decide what goes in.</p>
</div></body></html>`;
}

/* ----------------------------------------------------------------- server */

const server = createServer(async (req, res) => {
  const send = (status, body, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };

  if (req.method === 'GET') {
    if (new URL(req.url, 'http://127.0.0.1').pathname === '/api/state') {
      send(
        200,
        JSON.stringify(
          {
            quotes: listJson(QUOTES_DIR).map((q) => q.data),
            candidates: listJson(CANDIDATES_DIR).map((c) => c.data),
            lastRun: readJson(join(LOG_DIR, 'last-run.json')),
          },
          null,
          2,
        ),
        'application/json',
      );
      return;
    }
    send(200, render());
    return;
  }

  if (req.method !== 'POST') {
    send(405, 'method not allowed');
    return;
  }

  const body = await new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(new URLSearchParams(raw)));
  });
  const action = body.get('action');
  const id = body.get('id');
  let message = null;

  try {
    if (action === 'approve' && id) {
      const path = join(CANDIDATES_DIR, `${id}.json`);
      const candidate = readJson(path);
      if (!candidate) {
        message = { ok: false, text: `No candidate ${id}.` };
      } else {
        const result = publish(candidate);
        if (!result.ok) {
          message = { ok: false, text: result.message };
        } else {
          const check = await validate();
          if (!check.ok) {
            rmSync(result.target, { force: true });
            message = { ok: false, text: `Rejected by the validator, nothing published:\n${check.output}` };
          } else {
            mkdirSync(APPROVED_DIR, { recursive: true });
            renameSync(path, join(APPROVED_DIR, `${id}.json`));
            message = { ok: true, text: `${result.message}\n${check.output}` };
          }
        }
      }
    } else if (action === 'reject' && id) {
      const path = join(CANDIDATES_DIR, `${id}.json`);
      if (existsSync(path)) {
        mkdirSync(REJECTED_DIR, { recursive: true });
        renameSync(path, join(REJECTED_DIR, `${id}.json`));
        message = { ok: true, text: `Rejected ${id}.` };
      } else {
        message = { ok: false, text: `No candidate ${id}.` };
      }
    } else if (action === 'retract' && id) {
      const path = join(QUOTES_DIR, `${id}.json`);
      const quote = readJson(path);
      if (quote) {
        quote.status = 'retracted';
        quote.notes = `${quote.notes ?? ''} Retracted via dashboard on ${new Date().toISOString().slice(0, 10)}.`.trim();
        writeFileSync(path, `${JSON.stringify(quote, null, 2)}\n`);
        const check = await validate();
        message = { ok: check.ok, text: `Retracted ${id} (kept in the store, excluded from the site).\n${check.output}` };
      } else {
        message = { ok: false, text: `No quote ${id}.` };
      }
    } else if (action === 'ingest') {
      const { stdout } = await run('node', [join(ROOT, 'tools/ingest.mjs')], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 }).catch((err) => ({
        stdout: `${err.stdout ?? ''}\n${err.stderr ?? ''}`,
      }));
      message = { ok: true, text: stdout.trim() };
    } else if (action === 'validate') {
      const check = await validate();
      message = { ok: check.ok, text: check.output };
    } else if (action === 'build') {
      const result = await run('npm', ['run', 'build'], { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 }).catch((err) => ({
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? 'build failed',
      }));
      message = { ok: !/error/i.test(result.stderr ?? ''), text: `${result.stdout}\n${result.stderr}`.trim().slice(-1500) };
    } else if (action === 'gitstatus') {
      const result = await run('git', ['status', '--short', '--branch'], { cwd: ROOT }).catch((err) => ({ stdout: err.stderr ?? '' }));
      message = { ok: true, text: result.stdout.trim() || 'clean' };
    } else {
      message = { ok: false, text: 'Unknown action.' };
    }
  } catch (err) {
    message = { ok: false, text: `Action failed: ${err.message}` };
  }

  send(200, render(message));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Quotes on don pipeline dashboard → http://127.0.0.1:${PORT}`);
  console.log(`reviewing ${listJson(CANDIDATES_DIR).length} candidate(s), ${listJson(QUOTES_DIR).length} published quote(s)`);
});