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
Related context →  src/github/related.ts  covering tests and callers (background)
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
| Related context is not reviewable | `related.ts` labels it explicitly and `anchor.ts` drops any finding against it |

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
- Writes are never replayed after an ambiguous failure. GitHub rejects a
  rate-limited request before acting on it, so those are retried; a 5xx or a
  lost connection on a `POST` might mean the review landed, so Half-Shell fails
  that run rather than risk a duplicate review. The finding is not recorded as
  published, so the next push or `@half-shell review` posts it.

## Related context

Beyond the diff, the context builder pulls in the covering test for each
changed file (by convention: `x.test.ts`, `x.spec.ts`, `__tests__/x`,
`test_x.py`, mirrored `test/` trees) and, best-effort via code search, files
that call the changed code. This is background: it is rendered under an
explicit "NOT part of this change" banner, and diff anchoring already refuses
to publish a finding against a file outside the diff. Code search is
rate-limited and index-lagged, so any failure yields no context rather than a
failed review. Tune with `HALF_SHELL_MAX_RELATED_FILES` (0 disables) and
`HALF_SHELL_SEARCH_CALLERS`.

## Persistence

Two implementations of the same `Store` interface, selected with
`HALF_SHELL_STORE`:

- `file` (default) — one JSON file per pull request under `HALF_SHELL_DATA_DIR`,
  with writes serialized per pull request. Fine for a single instance.
- `sqlite` — a single database at `HALF_SHELL_DATABASE_PATH`, via Node's
  built-in `node:sqlite`, so it costs no dependency. Use it when the deployment
  outlives its container.

Both keep the last 20 runs per pull request plus published findings and
resolutions, and both are covered by the same test suite.

Finding state is keyed by the stable finding hash, never by the protocol's
`finding_id` — `HS-001` recurs on every run, so resolving a finding by that id
would mark whichever finding happened to be first.

## Telemetry

Every run records wall-clock duration, per-phase timing, provider call and
failure counts, and prompt/completion tokens where the endpoint reports them.
Totals are logged when a review finishes and printed by `@half-shell explain`.
A standard review costs roughly 15 provider calls: one briefing, six lanes, six
Sparring passes, one Shredder challenge, one verdict.

## Surviving a force-push

A rebase moves code out from under an inline comment, and GitHub marks the
original thread outdated. On re-review, a finding whose stable key was already
published but whose anchor has moved gets a reply in its existing thread with
the new location. This states location only — whether a finding is resolved
stays Leonardo's call, reached through the follow-up path.

## Running it without credentials

`src/harness/` boots the real service against a stub GitHub and a stub
OpenAI-compatible endpoint. Everything below the network boundary is production
code: signature verification, App JWT signing, installation tokens, the council
pipeline, publication and persistence.

```bash
npm run harness    # prints the review Half-Shell would post
npm test           # includes the end-to-end suite
```

The stub inference server answers each phase from a script, so failure paths —
a dead verdict phase, a failed Shredder challenge, a transient GitHub 500 — are
all reproducible.

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
