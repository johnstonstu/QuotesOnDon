# Research area

Subagents work **here** and nowhere else. The point of this directory is that research can run
unattended without any risk to the quote store: nothing in `data/quotes/` is touched, nothing is
published, nothing is committed by a subagent.

## The contract

- **Write exactly one file per task:** `research/<task-id>.md`. Nothing else. No edits to `src/`,
  `tools/`, `data/quotes/`, `data/sources.json`, `package.json`, or CI.
- **Evidence or it didn't happen.** Every claim carries a URL that you actually fetched, and the
  verbatim text you got back. A finding with no URL is not a finding — say "not verified" instead.
- **Say what failed.** Dead links, blocks, rate limits and paywalls are results. Report them.
- **No proposing.** This is research, not implementation: report options, costs, trade-offs and a
  recommendation. Do not change behaviour.

## Required sections

`tools/check-research.mjs` enforces these, and it runs as part of CI, so a malformed report fails the
build rather than sitting unread:

| Section | What belongs there |
| --- | --- |
| `## Question` | The task's question in one or two lines, restated. |
| `## Method` | Exactly what you did: commands, endpoints, sample size, date run. Reproducible. |
| `## Findings` | Numbered findings. Each one cites the evidence below by URL. |
| `## Evidence` | Fetched URLs with a verbatim excerpt of what came back. One per finding minimum. |
| `## Confidence` | Per finding: high / medium / low, and what would raise it. |
| `## Open questions` | What you could not settle. Honest gaps, not filler. |

Run it yourself before you finish:

```bash
node tools/check-research.mjs research/<task-id>.md
```

## Starting point

Copy `_TEMPLATE.md`. Files beginning with `_` are ignored by the gate.
