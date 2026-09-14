# Roadmap and dispatch

Research work for this project is queued here as **packets**: one task, one branch, one file, one
acceptance command, no merge. The shape is deliberately narrow because the value of the research is
that it can run unattended without any risk to the quote store.

```
docs/roadmap/tasks.json          single source of truth: six research tasks
docs/roadmap/packets/<task>.json  generated dispatch packets (do not hand-edit)
research/<task>.md                where each task writes its report — the only writable area
tools/check-research.mjs          the gate every report must pass
tools/make-packets.mjs            regenerates the packets; --check fails if they drift
```

## Lifecycle

1. **Dispatch** one packet per worker, on its own branch, with only `research/` writable.
2. **Worker writes** `research/<task>.md` with the six required sections and commits once.
3. **Gate** — `node tools/check-research.mjs research/<task>.md`. This is the acceptance command in
   every packet, and it also runs in CI, so an unsourced or half-finished report cannot slip in
   quietly.
4. **Coordinator reviews** the report against its `must_include` list. The report proposes; it never
   implements — adoption is a separate, reviewed change to `src/`, `tools/` or `data/quotes/`.
5. **Adopt or discard.** A discarded report stays in `research/` with its findings intact; that is
   still useful evidence.

## What no packet may touch

`src/`, `tools/`, `data/quotes/`, `data/candidates/`, `data/schema/`, `data/sources.json`, `public/`,
`package.json`, `.github/`, `astro.config.mjs`, `README.md`. Enforced by the packet's `excluded_paths`
and by the gate, which only ever runs against files under `research/`.

Publishing and spending stay human decisions. Nothing here commits to `main`, opens a PR, or merges —
the worker commits once on its own branch and stops.

## Regenerating packets

```bash
npm run packets         # rewrite docs/roadmap/packets/ from tasks.json
npm run packets:check   # fail if they have drifted (runs as part of npm test)
```

Edit `tasks.json`, not the packet files.

## Pinning the engine

Every packet ships with `"engine": "coordinator-choice"` and `"model": "coordinator-choice"`, and a
zero-dollar budget. That is intentional: the dispatcher pins the provider, model and budget, because a
task that chooses its own model has quietly chosen its own spend. Set them at dispatch time, not here.
