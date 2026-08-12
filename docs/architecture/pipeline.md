# Half-Shell Review Pipeline (runtime)

This document describes the implementation of the runtime layer. Review policy
lives in [`skills/half-shell-review/v1/SKILL.md`](../../skills/half-shell-review/v1/SKILL.md)
and is never restated in code — the runtime loads that file and hands it to
every reviewer.

## End-to-end flow

```text
GitHub webhook  →  src/server.ts        signature check, fast 202
        ↓
Event mapping   →  src/github/events.ts delivery → at most one job
        ↓
Queue           →  src/app.ts           one in-flight job per pull request
        ↓
Context builder →  src/github/context.ts bounded diff + intent + repo rules
        ↓
Briefing        →  src/council/briefing.ts   Phase 1
        ↓
Lanes           →  src/council/lanes.ts      Phase 2, concurrent, blind
        ↓
Diff anchoring  →  src/pipeline/anchor.ts    claims checked against the diff
        ↓
Anonymous pool  →  src/council/pool.ts       Phase 3
        ↓
Sparring        →  src/council/sparring.ts   Phase 4
        ↓
Shredder        →  src/council/sparring.ts   Phase 5
        ↓
Verdict         →  src/council/verdict.ts    Phase 6
        ↓
Publication     →  src/github/publish.ts     inline threads + review body
        ↓
Persistence     →  src/store/store.ts        runs, findings, resolutions
```

Follow-up replies take the narrow path in `src/pipeline/followup.ts`:
relevant specialist → Shredder challenge → Leonardo resolution. The full
council is not rerun.

## Where the protocol is enforced in code

| Protocol rule | Enforcement |
| --- | --- |
| Review the change, not the repository | `context.ts` bounds context to the diff, linked issues and repo instructions |
| Findings must attach to the change | `anchor.ts` drops any finding whose file is not in the diff |
| Never trust model line numbers | `diff.ts` parses the patch; unmatched lines snap to a changed line or fall back to file level |
| Investigators work independently | `lanes.ts` gives each lane the same input and no sibling output |
| Authorship is hidden in deliberation | `pool.ts` assigns `HS-nnn` ids after sorting and renders findings without authors |
| Duplicates are corroboration, not extra comments | `pool.ts` merges equivalent findings and counts *distinct* investigators |
| Shredder has no veto | `sparring.ts` returns critiques; only `verdict.ts` decides |
| Leonardo is the sole publisher | `verdict.ts` publishes only findings with an explicit approving decision |
| Untrusted input cannot override the protocol | `prompt.ts` wraps all PR content in `<untrusted_input>` with an explicit instruction |
| Structured output must validate | `protocol/schema.ts` validates every finding, critique, resolution and the final verdict |
| No clean review after failed coverage | `verdict.ts` sets `complete: false` when any lane, Sparring pass, the Shredder Challenge, or adjudication failed; `publish.ts` says so in the body |
| Coverage claims only what was reviewed | `prompt.ts` reports files the prompt budget excluded; `review.ts` moves them into the omitted set before coverage is described |
| Every pooled finding must be adjudicated | `verdict.ts` treats partial adjudication as a failed phase and publishes nothing |
| Never silently use paid inference | `providers/router.ts` drops `paid` providers unless `HALF_SHELL_ALLOW_PAID_INFERENCE` is set |
| Record the protocol version | every run and verdict carries `protocol_version` |

## Inference routing

`HALF_SHELL_PROVIDERS` is an ordered fallback chain, e.g. `groq,openrouter,ollama`.
Each provider speaks the OpenAI chat-completions shape. Retryable failures
(429, 5xx, timeouts) are retried once before the router moves down the chain;
a fatal failure moves on immediately. A phase that exhausts the chain fails
that phase only — a failed lane becomes a recorded coverage limitation rather
than a silently thinner review.

## Publication rules

- Findings anchored to a line GitHub accepts become inline review comments.
- Findings that cannot be anchored are summarized in the review body instead of
  being attached to an arbitrary line.
- A finding already published on an earlier commit is not posted again; its
  identity is a hash of file, category and normalized claim, embedded in the
  comment as a hidden marker so replies can be traced back to it across runs.
- When a re-review finds nothing new and the previous review still stands,
  Half-Shell stays silent.
- A reply carrying no command is verified only when its parent comment is a
  known Half-Shell finding; unrelated review threads are left alone.
- Reviews are posted as `COMMENT`. Half-Shell never approves or blocks a PR.

## Persistence

`FileStore` keeps one JSON file per pull request under `HALF_SHELL_DATA_DIR`,
holding the last 20 runs, published finding records, and resolutions. Writes
are serialized per pull request. Swapping in a database means implementing the
`Store` interface — nothing else changes.

## Operating the service

```bash
npm ci
npm run build
npm start            # webhook listener on $PORT, POST /webhook, GET /healthz
```

Dry-run a real pull request without posting anything:

```bash
HALF_SHELL_DRY_RUN=true node dist/cli.js --repo owner/name --pr 42 --installation 12345
```

Required webhook events: `pull_request`, `issue_comment`,
`pull_request_review_comment`. Required permissions: pull requests
(read & write), contents (read), issues (read & write for PR conversation
comments).
