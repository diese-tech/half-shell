# Council orchestration architecture

Source of truth for behavior: `config/council/orchestration.yaml` (runtime
knobs) and `config/personas/*.yaml` (character). This document explains how
they fit together and is not itself authoritative — if it disagrees with the
code or the config, the code and config win.

## Core authority rule

> Personas investigate, argue, teach, challenge, and recommend. Leonardo
> decides what the council believes. Half-Shell decides what the software
> does.

No persona ever calls a GitHub mutation API, submits a PR review state,
resolves a thread, or calls an arbitrary tool. `src/orchestration/engine.ts`
and `src/orchestration/phases/publication.ts` are the only code paths that
touch GitHub. Every persona invocation returns structured data validated
against a JSON Schema (`/schemas`) — the orchestrator never parses critical
state out of character prose.

Leonardo may unilaterally reject a surviving finding, narrow it, or change
its severity, but every one of those decisions is recorded with reasoning in
the verdict packet (`schemas/verdict.schema.json`). Shredder has no veto —
he can only make a finding fail to survive Sparring on the evidence.

## Lifecycle

```
RECEIVED → CASE_FILE → INDEPENDENT_REVIEW → MENTORSHIP → SYNTHESIS
  → SPARRING → LEO_REVIEW → PUBLICATION → ARCHIVED
```

Terminal/error states, reachable from any active phase:

```
FAILED_RETRYABLE   FAILED_FINAL   CANCELLED   SUPERSEDED
```

Every phase transition is a row written to the `review_run` store before the
phase's work begins, and updated when it completes
(`src/orchestration/store.ts`). The engine never depends on in-memory state
surviving a process restart — resuming a review means loading its current
phase from the store and continuing from there, not replaying from
`RECEIVED`. Each phase handler is idempotent: re-running a phase that already
wrote its output detects the existing output and returns it rather than
re-invoking a persona and risking a second, possibly-different answer.

## Review identity and webhook safety

A review run is keyed by `repository_id + pull_request_number + head_sha`
(`src/orchestration/identity.ts`). A new `head_sha` for the same PR is a new
**generation**.

- A webhook delivery is deduplicated by its `github_delivery_id`. A retry of
  a delivery already recorded for the same review is a no-op.
- If a newer `head_sha` arrives while an older run for the same PR is still
  active, the older run is marked `SUPERSEDED` and no further model calls are
  made against it.
- Before `PUBLICATION` sends anything to GitHub, the orchestrator re-fetches
  the PR and compares `current head SHA == review_run.head_sha`. A mismatch
  aborts publication and marks the run superseded rather than posting
  findings against code that has already moved.
- A second publication attempt for an already-published run is a no-op —
  publication looks up whether this run already has a recorded
  `github_publication_completed` event before doing anything.

## CASE_FILE — April

April builds the factual record before any specialist reviews the diff, so
nobody reviews an imagined version of the PR. Output is an evidence packet
(`schemas/evidence-packet.schema.json`) with three explicit buckets:

- **FACT** — directly supported by the diff, the PR, a linked issue, a
  comment, or repository guidance. Each fact carries a `source`.
- **INFERENCE** — a reasonable interpretation, not explicitly stated.
- **UNKNOWN** — a genuinely unresolved question. This is a valid, complete
  answer. April never fabricates intent to make the story feel finished.

Historical lookups are bounded: before another hop backward through PR/issue
history, April asks "could this realistically change the verdict?" — if not,
she stops. This keeps `CASE_FILE` from turning into unbounded repository
archaeology, mirroring the cost lesson Issue #1's related-context gather
already learned the hard way (see PR #2's HS-001).

## INDEPENDENT_REVIEW — Raph, Donnie, Mikey, Casey

The four specialists run in parallel and never see each other's raw
reasoning during this phase (`anonymity.between_reviewers: true`). This
matters for two reasons: it reduces anchoring (nobody's finding is shaped by
having read someone else's first), and it makes correlated-reasoning
detection in Synthesis meaningful — if two specialists reach the same
conclusion without having seen each other, that is real independent signal.

Each specialist's raw output is stored with full provenance
(`source_persona`) even though the payload the rest of the council sees
later is anonymized. Provenance is never destroyed, only hidden from the
Sparring transcript.

A specialist lane can fail (malformed response after retries, provider
error). A failed lane is never silently treated as "reviewed, found
nothing" — it's recorded as a missing lane, and Leo is told explicitly that
evidence is missing from that lane before he arbitrates.

## MENTORSHIP — Splinter

Splinter receives the candidate findings plus bounded historical context:
prior findings, prior resolutions, repository guidance, and recurrence
metadata. His rule is explicit: **history is a lens, never proof.** A prior
pattern justifies looking closer at the current PR; it does not substitute
for current evidence. An isolated defect is not inflated into a "pattern"
without at least one prior matching finding to point to.

## SYNTHESIS

Normalizes the raw candidate findings before Sparring, without deciding
which survive:

- assigns stable finding IDs
- deduplicates near-identical findings
- links related findings without merging their evidence
- separates observation ("it crashed") from root cause ("because of a race
  on this field") when only one is actually established
- flags conflicting claims between specialists instead of silently picking
  one
- applies the **corroboration rules** (below)
- strips `source_persona` from the payload that goes to Sparring — the
  Sparring transcript is anonymous — while the backend record keeps full
  lineage for provenance and the future Dojo web app

### Corroboration rules

| Situation | Effect |
|---|---|
| Shared assumption, no new evidence | no confidence gain |
| Repeated *unsupported* assumption | confidence **penalty** |
| Independent reviewers, same evidence | small confidence gain |
| Independent reviewers, distinct evidence | strong confidence gain |

Reviewer count is never itself evidence. Three reviewers repeating one
unsupported assumption is one unsupported argument, not three
confirmations. The example from Issue #12: Raph reproduces a duplicate-write
failure, Donnie independently traces the non-atomic shared-state path that
causes it — different evidence, same underlying bug — strong corroboration,
not merely "two people mentioned it."

## SPARRING

Participants: Raph, Donnie, Mikey, April, Casey, Splinter, Shredder. Findings
are anonymous in this payload (see Synthesis). Allowed actions: defend,
challenge, clarify, add evidence, narrow, withdraw, accept, merge related.

Shredder is adversarial by design — he starts from the position that nothing
should change unless the council proves it must — but he is bounded by a
challenge budget enforced **in code**, not by asking him nicely in the
prompt:

```yaml
initial_challenges_per_finding: 3
follow_up_rounds: 1
extend_only_if_new_evidence: true
```

`src/orchestration/phases/sparring.ts` tracks a challenge counter per finding
and rejects (does not even send to the model) any additional challenge past
budget unless the finding's evidence has materially changed since the last
challenge. Every challenge Shredder raises must name three things: the exact
claim challenged, the specific weakness, and what evidence would answer it —
a challenge missing any of those is invalid and does not consume budget
against the finding (it's a malformed-response retry, not a real objection).
Once a challenge is answered with strong evidence, Shredder cannot restate
the same skepticism in different words and call it a new objection — the
goalpost rule is enforced by comparing the new objection's target against
previously-answered objections for the same finding, not by trusting the
model not to repeat itself.

## LEO_REVIEW

Leo receives the surviving findings, the evidence packets, the Sparring
history, Shredder's challenges and their resolutions, Splinter's lessons,
and the corroboration metadata. He does not count votes — one strong
specialist finding can outweigh several weak objections, and a high
reviewer count is never a substitute for evidence.

Per finding, Leo's allowed outcomes are: publish, reject, merge, narrow,
raise severity, lower severity, or request more investigation (only when a
material unknown could actually change the verdict — this is not a way to
stall). Any rejection, narrowing, or severity change is recorded with
reasoning in `schemas/verdict.schema.json`'s per-finding `public_reason`.

Leo's verdict has an `overall_outcome` that is **not** itself a GitHub
review event — it's a materiality summary
(`clean_review` / `non_blocking_findings_published` /
`blocking_findings_published` / `incomplete`) that Publication maps
deterministically.

## PUBLICATION

Owned entirely by the orchestrator. Converts Leo's verdict into a GitHub PR
review outcome using `publication_policy` from `orchestration.yaml`:

| Verdict outcome | GitHub review event |
|---|---|
| One or more published findings at/above `blocking_severity_threshold` | `REQUEST_CHANGES` |
| Published findings exist, none blocking | `COMMENT` |
| No publishable material findings, review completed | `APPROVE` |

Before sending anything, the orchestrator re-checks
`current PR head SHA == review_run.head_sha` (see Webhook safety, above). If
publication fails partway (GitHub error, connection loss), the completed
verdict is preserved and publication is retried idempotently — a retry never
re-decides the verdict, it only re-attempts the GitHub call, and checks for
an existing `github_publication_completed` event first so a retry after a
successful-but-unacknowledged post does not double-post.

### Public vs. internal

The public GitHub review includes: the Half-Shell summary, approved
findings, relevant specialist attribution (who found what), and Leo's
verdict text. It excludes: the internal argument, withdrawn findings, failed
theories, raw personality chatter, and Leo's private reasoning process. A PR
author sees the outcome and the evidence behind it, not the committee
meeting.

## Event stream (Dojo web app)

Every phase, persona message, finding lifecycle transition, challenge,
experiment, lesson, and verdict is persisted as an **append-only** event
(`schemas/council-event.schema.json`) rather than a single flattened
transcript. `sequence` is monotonic within a `review_id`, so a future web UI
can deterministically reconstruct:

```
CASE FILE → PRIVATE INVESTIGATION → THE DOJO → SPARRING → THE VERDICT → PUBLICATION
```

Two views become possible on top of the same event log: a `clean_view`
(findings, evidence, verdict — what GitHub sees) and a `full_dojo` view
(character dialogue, challenges, disagreements, withdrawn findings,
Splinter's lessons, Leo's verdict) — without changing review semantics,
because the event log already has everything needed for either.

## Early exit

A review may skip Sparring and go straight to a minimal clean verdict only
when **all** of these hold: `CASE_FILE` completed, every required
independent-review lane returned clean, no unresolved context from April, no
material observation from any specialist, and nothing triggered a
guardrail/history match from Splinter. Never based solely on file type or
"this looks like docs" — a docs/config/schema-only PR can still contain a
material issue, and April deciding "no logic change" is not itself grounds
to skip review.

## Cost controls

`orchestration.yaml`'s `cost_controls` block: specialists run in parallel,
findings are deduplicated before the (expensive) Sparring phase runs,
Shredder's budget caps the total challenge/response calls, historical
context lookups are bounded (mirrors the request budget already added to
related-context gathering in PR #2), and a clean review exits early rather
than paying for a full Sparring pass it doesn't need.

## Provider abstraction

`src/orchestration/provider.ts` defines a `ModelProvider` adapter —
conceptually `generate(request: PersonaRequest): Promise<PersonaResponse>` —
wrapping the existing `ProviderRouter` (`src/providers/router.ts`), which
already supports a configurable free → free → local → paid fallback chain
speaking the OpenAI chat-completions shape. Persona → model-tier routing is
config-driven (`model_routing` in `orchestration.yaml`), not hard-coded to
any vendor. Character semantics do not change based on which provider
answers a given persona's prompt — the persona YAML and the phase contract
are the same regardless of what's on the other end of the HTTP call.

## Failure and retry policy

- Every model response is validated against its phase's JSON Schema before
  it's trusted as orchestration state.
- A malformed response retries up to `max_persona_retries_per_phase` (1) and
  persists a `validation_failed` event either way.
- A failed independent-review lane does not silently become "clean" — it's
  marked missing, and Leo's inputs explicitly note which lane is absent.
- GitHub mutation failures are retried, and retries are idempotent (see
  Publication).

## Security boundary

Casey can propose experiments; the orchestrator does not execute arbitrary
repository code or shell commands on his say-so. Until an explicit sandboxed
execution capability exists (not built in this pass — see Issue #12's
non-goals), his experiments remain recommendations, or are limited to
explicitly allowlisted existing test surfaces the orchestrator already knows
how to run safely.

## Worked example

```
April confirms Issue #83 reports duplicate Discord retry submissions.
  ↓
Raph independently finds a duplicate-write path.
Donnie independently finds a non-atomic shared-state dependency.
Casey reproduces rapid-retry behavior against the existing test harness.
  ↓
Synthesis links these as one finding while preserving three distinct
evidence sources — independent_distinct_evidence, strong confidence gain.
  ↓
Shredder challenges whether both writes can actually commit concurrently.
Evidence (Casey's reproduction) answers the challenge. Shredder accepts;
challenge count for this finding: 1 of 3.
  ↓
Leo publishes the finding, severity high (at the blocking threshold).
  ↓
Orchestrator re-checks the PR head SHA, posts REQUEST_CHANGES, records
github_publication_completed, archives the run.
```
