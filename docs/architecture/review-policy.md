# Half-Shell Review Policy

Status: **canonical product policy for the Council review engine**

This document records the product and review-policy decisions that govern how Half-Shell behaves as a GitHub App. It is intentionally separate from persona character files, runtime implementation details, and machine schemas.

Half-Shell's goal is to replace a conventional PR review bot with a readable, adversarial, character-driven Council that remains evidence-bound and useful enough to trust on real pull requests.

If an older v1 document conflicts with this policy for Council behavior, this document wins unless a scoped GitHub issue explicitly changes the policy.

---

## 1. Core product behavior

### One review mode

Half-Shell has one real review mode.

There is no separate `deep review` mode. A review should investigate the PR as deeply as the evidence requires while remaining bounded and relevant to the change.

The operative question is:

> Is this change safe, correct, complete, consistent with its intended requirements, and ready to merge?

The Council may follow relevant evidence beyond changed lines into callers, consumers, tests, schemas, configuration, linked requirements, repository guidance, history, and adjacent subsystem boundaries when necessary to answer that question confidently.

The boundary is relevance, not an artificial shallow/deep tier.

### Public command surface

The public MVP command surface is intentionally small:

- `@half-shell` — review or re-review the current PR state.
- `@half-shell explain` — explain the latest review without starting another review.
- Reply directly to a Half-Shell finding — trigger targeted verification/reconsideration of that finding.

Removed from the public surface:

- `@half-shell review`
- `@half-shell deep review`
- `@half-shell verify`
- `@half-shell reconsider`
- `@half-shell cancel`

Verification, reconsideration, cancellation, and re-review semantics remain internal operations selected by the orchestrator.

### Automatic review triggers

Half-Shell automatically reviews:

- a newly opened non-draft PR;
- a draft PR when it transitions to Ready for Review.

Half-Shell does not automatically launch a new full Council review for every pushed commit after the first review.

A subsequent push makes the previous review potentially stale. The next `@half-shell` reviews the PR as it exists at that moment.

Draft behavior:

- draft PR opened: no automatic review;
- commits pushed while draft: no automatic review;
- draft -> Ready for Review: automatic review;
- explicit `@half-shell` on an open draft PR: allowed.

### CI timing

Half-Shell and CI run independently and in parallel.

Half-Shell uses whatever CI/check evidence exists when the review runs, but does not wait indefinitely for CI to finish. Pending checks remain pending evidence. A later CI result does not retroactively mutate a completed review; the next `@half-shell` can consume the new evidence.

---

## 2. Review generation lifecycle

### Identity

A review generation is identified by repository, pull request, and head SHA.

### Latest SHA wins

If the PR head changes while a review is active:

1. the active generation becomes `SUPERSEDED`;
2. stale findings must not publish;
3. additional inference should stop where practical;
4. Half-Shell waits for a future explicit `@half-shell` rather than automatically reviewing the new SHA.

Publication must re-check the current PR head SHA before mutating GitHub.

### Duplicate mentions

For the same PR/SHA:

- active run + another `@half-shell`: deduplicate; do not start a second concurrent Council;
- completed run + another `@half-shell`: allow a fresh review;
- new SHA + `@half-shell`: allow a new review.

### Self-trigger protection

Half-Shell ignores events authored by its own installed GitHub App identity.

Do not globally ignore all bots. Other authorized bots/agents may invoke Half-Shell.

### Invocation permissions

Use GitHub repository permissions instead of a custom Half-Shell ACL for initial versions.

- Private repositories: legitimate PR participants with appropriate repository access may invoke.
- Public repositories: require collaborator/write-level access for inference-triggering mentions to limit abuse.
- External agents/bots remain eligible when their GitHub identity has the required permission.

### Cancellation

There is no public cancel command in v1.

The orchestrator cancels or supersedes work for lifecycle reasons such as:

- PR closed/merged;
- new head SHA;
- repository/App access lost;
- operational shutdown/recovery.

`CANCELLED` remains a first-class persisted state.

---

## 3. Findings: priority, blocking, and merge readiness

### Priority scale

Published findings use Codex-style priority levels instead of `critical/high/medium/low` severity labels:

- **P0** — catastrophic or immediately severe: major security exposure, data corruption/loss, widespread availability failure, etc.
- **P1** — material defect that normally should be fixed before merge: concrete correctness, security, regression, or contract failure.
- **P2** — legitimate issue worth addressing, generally limited in impact and not inherently merge-blocking.
- **P3** — real but low-impact issue. Publish sparingly.

P3 is not a style/nitpick bucket. Formatting taste, naming preferences, optional refactors, generic best practice, and speculative cleanup should normally be suppressed.

### Priority is not blocking

Priority and blocking are separate dimensions:

```text
priority = urgency / impact
blocking = merge-readiness
```

A P2 can block when it directly falsifies an explicit acceptance criterion or required invariant. A P1 is usually blocking but is not blocking merely because it is P1.

A finding record therefore needs at least:

```text
priority: P0 | P1 | P2 | P3
blocking: boolean
blockingReason?: string
```

### Blocking semantics

A finding is blocking when the PR cannot truthfully satisfy an explicit requirement, acceptance criterion, safety invariant, required behavior, or merge-readiness condition while the finding remains valid.

Vague intent such as "improve reliability" does not create a testable blocking criterion by itself.

### GitHub review outcome

For the initial Codex-like versions:

- one or more surviving blocking findings -> `REQUEST_CHANGES`;
- only non-blocking findings -> `COMMENT`;
- clean review -> themed `COMMENT`, not `APPROVE`;
- incomplete review -> themed no-verdict `COMMENT` when safe to publish.

Half-Shell does not grant merge authorization by default.

A previous `REQUEST_CHANGES` followed by a clean re-review should produce an explicit themed comment that Half-Shell's blockers are resolved. Exact GitHub branch/ruleset behavior must be validated during live deployment rather than assumed by policy.

Unresolved non-blocking findings do not inherently prevent merge.

### Resolution requirement

Every published finding defines what must become true for the finding to be considered resolved:

```text
resolutionRequirement: string
suggestedApproach?: string
```

The suggested implementation is optional. Re-review verifies the original failure mode and resolution requirement, not whether the author copied Half-Shell's suggested patch literally.

---

## 4. Publication personality and presentation

### Personality is a product requirement

Half-Shell is not a technical-jargon bot wearing a turtle theme. Character voice, humor, readability, and personality are first-class requirements of public output.

Technical accuracy and evidence remain non-negotiable, but findings should feel authored by the Council.

All user-facing GitHub output is themed through a deterministic presentation/message layer, including:

- clean reviews;
- findings;
- request-changes summaries;
- failed/incomplete reviews;
- superseded-state explanations;
- finding resolutions;
- finding-still-valid replies;
- `@half-shell explain`;
- already-reviewing acknowledgements;
- permission/invalid-command responses.

Theme wraps facts. It never changes underlying structured state.

### Finding authorship

Individual findings are led by the most relevant persona(s), not Leonardo.

A finding may be primarily Raph, Donnie, Mikey, Casey, April, Splinter, etc. Other Council members may appear briefly when their corroboration, challenge, reproduction, or added evidence materially improves the explanation.

Do not dump full conversations into GitHub comments.

Rule:

> GitHub gets the conclusion and the best supporting moments. The transcript gets the conversation.

### Leonardo's public role

Leonardo owns the final review summary/verdict only.

He does not rewrite every specialist finding into his own voice.

The final report should contain a stable information hierarchy:

1. Leo/verdict framing;
2. overall state;
3. blocker/non-blocker count;
4. concise finding rollup;
5. optional notable positive observation;
6. optional `View the Dojo` link.

### Clean review

A successfully completed clean review always leaves a concise themed confirmation instead of staying silent.

The exact reply pool will be workshopped separately. First review and clean re-review may use different deterministic variants.

### Incomplete review

A failed or meaningfully incomplete review can never use clean-review language.

When safe to publish, Half-Shell should clearly say the Dojo could not complete the round and that no clean verdict was issued. `@half-shell` retries the current PR state.

### Positive observations

Half-Shell may surface one concise, evidence-backed positive observation in the overall review when something genuinely stands out.

Do not create standalone praise comments and do not manufacture praise for every review.

### Inline placement

Prefer meaningful inline findings when GitHub can anchor them safely.

Do not attach a finding to an arbitrary line merely to make it inline.

Cross-cutting or unanchorable findings remain PR-level findings. A finding may carry multiple evidence locations with one optional primary GitHub anchor.

### Out-of-diff findings

An out-of-diff defect is publishable only when the PR materially causes, exposes, or makes that existing code newly relevant.

Unrelated pre-existing defects are not charged against the current PR.

---

## 5. Transcript and View the Dojo

Every review generation has an immutable persisted Council transcript/event history.

A re-review creates a new generation and therefore a new historical transcript.

GitHub comments contain concise Council output, not the entire deliberation.

When a transcript viewer exists, completed reviews may include an optional `View the Dojo` link.

The publication payload should support:

```text
reviewId
transcriptAvailable
transcriptUrl?
```

If there is no viewer/URL, do not render a fake link.

### Transcript access

Transcript visibility inherits repository visibility and permissions:

- public repository: transcript may be public;
- private repository: viewer must authenticate and be authorized for the repository;
- no repository access: no transcript access.

The transcript is historical, read-only review evidence.

### Security-sensitive transcript content

Genuinely disclosure-sensitive security findings may use restricted publication. Public GitHub output should provide enough information to act without publishing exploit details.

Full evidence remains in the access-controlled review record/transcript.

Restricted disclosure requires a concrete security/disclosure reason; it cannot be used to hide inconvenient findings.

---

## 6. Re-review and finding continuity

A re-review is context-aware. It does not behave as if Half-Shell has never seen the PR.

Relevant previous findings are reconciled into states such as:

- `RESOLVED`;
- `STILL_VALID`;
- `PARTIALLY_RESOLVED`;
- `SUPERSEDED`.

Existing threads should be updated when useful instead of reposting identical findings.

The final re-review summary reports the delta, for example:

```text
2 fixed
1 still standing
1 new
```

Stable finding identity is mandatory internally across review generations.

Human-facing finding IDs should not dominate the UX. Stable keys/IDs may exist in hidden metadata, transcript navigation, debugging, and support tooling.

---

## 7. Canonical persisted review payload

Persist one authoritative, versioned `ReviewRecord` per review generation.

Nested types are allowed, but the review generation serializes into one canonical artifact containing at least:

```ts
type ReviewRecord = {
  schemaVersion: number;

  review: ReviewIdentityAndLifecycle;
  reviewEnvironment: ReviewEnvironment;
  caseFile: CaseFile;
  coverage: CoverageRecord;
  findings: FindingRecord[];
  verdict: VerdictRecord;
  reconciliation: ReconciliationRecord;
  transcript: TranscriptRecord;
  publication: PublicationRecord;
  telemetry: TelemetryRecord;
  dataEgress: DataEgressRecord[];
  contextRequests: ContextRequestRecord[];
};
```

Persist facts and structured state, not rendered GitHub prose. Public themed text is generated from structured state.

Transcript events are the exception because persona dialogue is itself historical review data.

### Review environment / auditability

Every generation permanently records the configuration that produced it, including:

- Half-Shell version;
- protocol version;
- orchestration version;
- persona versions;
- retrieval profile version;
- repository memory version when applicable;
- actual provider/model used per persona;
- relevant inference/egress policy.

The goal is auditability, not pretending LLM output is deterministically reproducible.

---

## 8. Evidence model

Evidence is first-class structured data, not just prose inside findings.

Each material claim should reference `EvidenceRef` records containing traceable provenance such as:

```ts
type EvidenceRef = {
  id: string;
  sourceType:
    | "diff"
    | "repository_file"
    | "test"
    | "pull_request"
    | "issue"
    | "comment"
    | "repository_guidance"
    | "prior_finding"
    | "runtime_result"
    | "ci";
  source: {
    path?: string;
    startLine?: number;
    endLine?: number;
    sha?: string;
    issueNumber?: number;
    commentId?: number;
    url?: string;
  };
  observation: string;
  strength: "direct" | "supporting" | "contextual";
  sensitive?: boolean;
};
```

Do not persist entire source files in the review record merely to preserve evidence. Store references and bounded excerpts/hashes when needed.

### Secret handling

Probable secrets/credentials are hazardous evidence.

Where practical, redact them before model/context distribution and never reproduce full values in:

- prompts beyond necessity;
- transcripts;
- GitHub comments;
- logs;
- telemetry;
- repository memory.

Store location plus fingerprint/redacted evidence instead.

---

## 9. Finding schema semantics

### Categories

Use a compact machine-oriented category enum:

- `correctness`
- `security`
- `contract`
- `concurrency`
- `data_integrity`
- `incomplete_change`
- `test_coverage`
- `operational`

Categories are for organization, analytics, and context strategy. They do not determine which personas are allowed to review a finding or a portion of the PR.

Regression is metadata, not a category:

```text
isRegression: boolean
```

Other cross-cutting attributes should likewise remain metadata rather than exploding the primary category enum.

### Confidence

Use:

```text
low | medium | high
```

Do not expose fake numeric precision such as `0.87` as if model confidence were scientific measurement.

Low-confidence claims generally should not publish. They should be investigated, rejected, or converted into a genuine coverage limitation when necessary evidence cannot be obtained.

Confidence is usually internal rather than displayed in GitHub findings.

---

## 10. Full-PR Council coverage

Every core reviewing persona evaluates the complete bounded PR context independently according to their own perspective.

Do not partition the PR by category or file type such as:

```text
API -> Donnie only
tests -> Casey only
UX -> Mikey only
security -> Splinter only
```

Categories describe findings after discovery. They never determine reviewer eligibility.

April and Splinter also receive whole-change visibility appropriate to their phases. Shredder and Leo operate over the resulting complete Council record.

Cost optimization may bound what repository context enters the review, but must not artificially partition the resulting PR context between reviewers.

---

## 11. Context selection and expansion

### Initial context

Start with the complete bounded PR map and smallest relevant evidence set, including changed files, intent, relevant tests/contracts/guidance, and known prior findings where applicable.

### Structured context expansion

Personas may request additional context through bounded structured requests such as:

- definitions;
- references/callers/consumers;
- tests;
- schemas/types;
- configuration;
- linked history;
- other directly relevant repository evidence.

The model does not browse freely or call arbitrary tools. It emits an expansion request; the orchestrator retrieves and labels the evidence.

Each reviewer has a finite context-expansion budget.

During independent review, one persona's requested evidence should not immediately anchor sibling reviewers. After independent review, retrieved evidence may enter Synthesis/Sparring.

### Large PRs

If a PR exceeds context limits:

1. map the entire change;
2. prioritize meaningful/high-risk context rather than arbitrary first-N files;
3. record all omitted/reduced scope;
4. do not issue a clean verdict when meaningful review scope remains uncovered.

File type alone never makes a change irrelevant.

Generated files, lockfiles, vendored/minified content, binaries, and huge diffs may be summarized/compressed when appropriate, but reductions/exclusions are recorded in coverage.

---

## 12. Adaptive/self-learning retrieval

Half-Shell may learn **how to retrieve better context**, not what conclusions to believe.

Every context request should be recorded with persona, reason, target, returned evidence, and usefulness outcome such as:

- `used_in_finding`;
- `used_in_challenge`;
- `used_in_verdict`;
- `context_only`;
- `unused`.

### Promotion into automatic prefetch

Start conservatively. A candidate persona/retrieval/change-pattern may become automatic only after repeated evidence, initially around:

- at least 5 relevant requests; and
- at least 70% usefulness.

These are initial policy defaults, not immutable constants.

Promoted behavior is continuously measured and can be demoted if usefulness drops.

Learning begins repository-scoped.

Example:

```text
Donnie + API contract changes
-> repeatedly requests direct consumers
-> request proves useful consistently
-> callers become automatic prefetch for Donnie in this repo
```

Do not rewrite persona YAML automatically based on these trends.

### Global strategy promotion

Repository facts never cross repository boundaries.

Investigation strategy may eventually become global only after repeated evidence across unrelated repositories.

For initial versions, global promotion requires human approval.

---

## 13. Repository memory

Half-Shell may maintain provenance-backed, repository-scoped memory of verified knowledge such as:

- architectural invariants;
- confirmed contracts;
- recurring failure patterns;
- relevant file/relationship patterns;
- repository terminology;
- recurring CI/test behavior;
- prior findings/resolutions;
- explicitly documented decisions.

Memory is never proof by itself.

Rule:

> Memory tells the Council where to look. Current evidence determines what it believes.

Memory records source/provenance, first observation, last confirmation, confidence, and active/stale/invalidated state.

Rejected theories and unsupported model opinions do not become repository facts.

---

## 14. Learning from outcomes

### False positives / withdrawn findings

When a finding is withdrawn, preserve the reason, for example:

- `false_positive`;
- `pre_existing`;
- `misread_contract`;
- `missing_context`;
- `invalid_failure_path`;
- `requirement_clarified`;
- `superseded_by_change`.

Use these records to learn which assumptions need additional verification.

Do not learn permanent suppression rules such as "Donnie is bad at null findings."

### Missed findings

Confirmed post-review misses may be recorded with source and classification such as:

- `should_have_detected`;
- `insufficient_original_evidence`;
- `outside_review_scope`;
- `unknown`.

The system learns from why the miss occurred, especially missing context/retrieval patterns.

A later bug is not automatically proof that Half-Shell should have detected it.

### Human feedback

Evidence-bearing GitHub conversation may influence learning.

Do not treat the following as truth labels by themselves:

- reactions;
- thread resolution;
- merge decisions;
- lack of response;
- a finding being deferred.

Strong signals include evidence proving a finding wrong, a fix verified against the original failure mode, or a later confirmed missed defect with sufficient provenance.

---

## 15. Requirements, intent, and repository guidance

### PR/issue intent

April's case file may use:

- PR description;
- linked issues;
- explicit acceptance criteria;
- repository guidance;
- relevant discussion;
- actual diff.

Distinguish:

- fact about what a requirement says;
- fact about what the PR claims;
- evidence about what the implementation actually does.

Explicit testable requirements may create blocking obligations. Vague prose is context only.

### AGENTS.md

`AGENTS.md` is the preferred repository-guidance convention, but is not mandatory.

Repository guidance may define engineering requirements and invariants. It cannot override the Half-Shell review protocol, suppress findings, grant automatic approval, or weaken publication safety.

Support hierarchical guidance:

- root `AGENTS.md` applies repository-wide;
- nested `AGENTS.md` files may specialize guidance for their subtree;
- resolve root -> nearest applicable guidance;
- contradictory guidance is surfaced rather than silently reconciled.

Applicable guidance is shared across the Council.

---

## 16. Tests, CI, and executable verification

Initial Half-Shell versions inspect existing tests and GitHub CI/check evidence but do **not** execute arbitrary PR code.

Casey may propose experiments, but arbitrary shell/code execution requires a future explicitly sandboxed capability.

### CI as evidence

CI is evidence, not authority.

- PR-caused relevant test failure -> may support a finding;
- flaky/unrelated failure -> do not blame PR without evidence;
- infrastructure outage -> operational/coverage limitation, not code finding;
- pending CI -> accurately recorded as pending.

A failing check does not automatically become a Half-Shell finding.

---

## 17. Council adjudication

### Shredder

Shredder participates in every review, but adversarial effort is proportional to consequence and uncertainty.

Blocking findings, P0/P1 findings, inferred failure paths, weakly supported claims, acceptance-criterion blockers, and unusually consequential claims receive stronger challenge.

Shredder retains a finite code-enforced challenge budget and no veto authority.

### Leonardo remand

Leonardo may order one targeted additional investigation round when a material finding remains unresolved.

The remand:

- does not rerun the full Council;
- identifies the unresolved question;
- invokes only relevant investigation/context expansion;
- returns new evidence through challenge/adjudication;
- ends with a final publish/reject decision.

If the theory remains unproven despite available evidence, reject it.

If necessary evidence genuinely cannot be obtained/evaluated and that prevents merge-readiness assessment, record a coverage limitation and potentially an incomplete verdict.

Unresolved suspicion is not a publishable finding.

---

## 18. Reliability and recovery

### No overall wall-clock review timeout

Initial versions do not impose an arbitrary total review stopwatch.

Instead:

- provider/network calls have sensible timeouts;
- retries are finite;
- context-expansion rounds are finite;
- Shredder challenges are finite;
- Leo gets one bounded remand.

A slow-but-progressing review may finish and produce a legitimate clean verdict.

### Crash/restart recovery

Persist phase/lane progress so an interrupted review can resume safely when:

- PR remains open;
- head SHA still matches;
- run is not superseded/cancelled.

Do not repeat completed inference unnecessarily.

GitHub publication must be idempotent/recoverable and consult persisted state before mutation.

### Review concurrency

Support multiple PRs concurrently through a durable queue with configurable global/provider concurrency limits.

Allow only one active generation per PR.

If queued work becomes stale before starting, supersede it rather than spending inference on old code.

### Rate limits

Transient rate limits cause bounded backoff/waiting and scheduler-level throttling rather than immediate failure.

Actual budget/capability exhaustion with no acceptable fallback produces incomplete coverage, never silent model degradation.

---

## 19. Provider/model routing

### Abstract capability tiers

Personas route through abstract capability tiers rather than hard-coded vendors.

Initial conceptual minimums:

- April -> `standard+`
- Raph -> `standard+`
- Donnie -> `reasoning+`
- Mikey -> `standard+`
- Casey -> `standard+`
- Splinter -> `standard+`
- Shredder -> `reasoning+`
- Leo -> `strongest+`

Exact tier labels/config may evolve, but every persona has a minimum acceptable capability.

Fallback is allowed only at or above that minimum.

If no acceptable model can complete a required persona lane, coverage is incomplete.

### Risk-based escalation

Half-Shell may escalate individual personas above their default tier based on evidence-backed PR risk or unresolved investigation complexity.

Examples include auth/security changes, persistence/migrations, concurrency, public contract changes, infrastructure, large blast radius, or unresolved material ambiguity.

Do not dynamically downgrade below configured minimums.

All escalations are recorded for later evaluation.

### Model qualification

Local models may be qualified per persona/tier through a repeatable evaluation harness covering representative cases such as:

- correctness regression;
- contract mismatch;
- concurrency;
- incomplete implementation;
- operational abuse;
- false-positive traps;
- requirement violations;
- clean PRs.

Evaluate confirmed findings caught, false positives, evidence quality, abstention, context requests, blocking classification, and schema compliance.

A model may qualify for one persona/tier and not another.

---

## 20. Local-first inference and privacy

Half-Shell is provider-agnostic but explicitly supports local-first Ollama operation.

A deployment may resolve capability tiers to local models and use cloud only as configured fallback/escalation.

### Local worker availability

If local inference is expected and the worker is temporarily unavailable, queue/wait by default rather than silently sending repository context to cloud.

Supported policy concepts:

- `local_only`
- `local_preferred`
- `cloud_allowed`

Cloud fallback occurs only when policy permits it.

Queued generations remain SHA-aware and can become superseded before the worker returns.

### Data egress

Inference policy and data-egress policy are explicit and separately enforced.

Cloud calls receive the minimum task-relevant evidence rather than the entire case file by default.

Every external context disclosure is auditable in `ReviewRecord`, including provider, purpose, and evidence identifiers sent.

`local_only` is a real data-handling guarantee, not just a provider preference.

---

## 21. Source-of-truth principle

For Council product behavior, this document defines the intended product policy.

Machine behavior should be implemented through config/schemas/code without duplicating contradictory policy prose.

When policy evolves, update this document as part of the scoped change.

Legacy v1 behavior may remain different behind an explicit engine boundary until it is intentionally retired or migrated.

---

# Locked decision index

The following index exists to make future discussion refer to stable decision IDs rather than reconstructing intent from chat.

- **D001** One adaptive full review mode; remove deep review.
- **D002** P0-P3 priorities replace critical/high/medium/low for published findings.
- **D003** Blocking is independent of priority.
- **D004** Council uses REQUEST_CHANGES for blockers, COMMENT otherwise; no APPROVE initially.
- **D005** Bare `@half-shell` is the sole public review/re-review invocation.
- **D006** No public re-check/verify command; re-review is context-aware.
- **D007** Finding replies automatically trigger targeted reconsideration/verification.
- **D008** Keep `@half-shell explain` read-only.
- **D009** Automatic first review on open/ready; pushes do not auto re-review.
- **D010** Drafts suppress automatic review but allow explicit `@half-shell`.
- **D011** New head SHA supersedes active review and stale results never publish.
- **D012** Concurrent same-SHA mentions deduplicate; completed same-SHA reruns are allowed.
- **D013** Ignore only Half-Shell's own App-generated triggers; authorized external bots remain eligible.
- **D014** Invocation authorization inherits GitHub permissions; public repos require write/collaborator access.
- **D015** Clean reviews always publish a concise themed confirmation.
- **D016** All Half-Shell public output is themed through a deterministic presentation layer.
- **D017** Persona voice is a first-class requirement of findings.
- **D018** Findings may include concise supporting Council contributions when they improve the explanation.
- **D019** Full deliberation stays transcript-side; GitHub gets main points.
- **D020** Every generation has an immutable access-controlled transcript and optional future View the Dojo URL.
- **D021** Re-reviews reconcile previous findings rather than starting from amnesia.
- **D022** Stable finding IDs/keys are mandatory internally but de-emphasized in public UX.
- **D023** One canonical versioned ReviewRecord represents a complete review generation.
- **D024** Evidence is structured/source-addressable first-class data.
- **D025** Use compact finding categories; regression and similar properties are separate metadata.
- **D026** Every core persona reviews the complete bounded PR context; categories never partition reviewer eligibility.
- **D027** Confidence is low/medium/high internally, not fake-precision numeric scoring.
- **D028** Every published finding has a resolution requirement; suggested implementation is optional.
- **D029** Only explicitly blocking findings participate in Half-Shell's merge gate.
- **D030** Clean re-review reports blockers cleared; exact GitHub gate release behavior is validated in deployment/ruleset config.
- **D031** Explicit testable requirements may establish blockers; vague intent does not.
- **D032** AGENTS.md is preferred repository guidance; repo guidance cannot override Half-Shell protocol.
- **D033** Support hierarchical/nested AGENTS.md guidance and surface conflicts.
- **D034** Inspect tests/CI but do not execute arbitrary PR code in initial versions.
- **D035** CI runs independently; CI failures are evidence only when attributable to the PR.
- **D036** File classification may optimize context but never silently exempt changed files from review eligibility.
- **D037** Oversized PRs use intelligent risk-based context selection and cannot receive a clean verdict with meaningful uncovered scope.
- **D038** Personas can request bounded structured context expansion through the orchestrator.
- **D039** Learn persona-specific retrieval patterns and promote consistently useful requests into prefetch.
- **D040** Initial retrieval promotion requires repeated measured usefulness and remains reversible/repo-scoped.
- **D041** Repository memory stores provenance-backed verified knowledge; memory guides investigation but is never proof.
- **D042** False positives teach additional verification requirements, not permanent suppression.
- **D043** Confirmed misses become structured evaluation/learning records.
- **D044** Evidence-bearing human feedback can teach; reactions/merge/thread resolution alone cannot.
- **D045** Repository facts never cross repos; global strategy promotion requires cross-repo evidence and initial human approval.
- **D046** Every review records its exact review environment/configuration for auditability.
- **D047** Provider fallback is allowed only through acceptable capability tiers; required-lane failure prevents clean verdict.
- **D048** Personas have minimum capability tiers rather than permanent vendor assignments.
- **D049** PR risk/ambiguity may escalate personas upward, never silently downward.
- **D050** Shredder participates in every review and spends more adversarial effort on consequential/uncertain findings.
- **D051** Leo gets one targeted remand round for materially unresolved findings.
- **D052** Unproven suspicions are rejected; genuine missing necessary evidence becomes coverage limitation.
- **D053** P3 is concrete low-impact defect only, never style/nitpick noise.
- **D054** One optional evidence-backed positive observation may appear in the final summary.
- **D055** Persona(s) own finding presentation; Leo owns only the overall verdict/summary.
- **D056** Prefer meaningful inline anchors; cross-cutting findings can remain PR-level with multiple evidence locations.
- **D057** Out-of-diff findings require a causal/newly-exposed relationship to the PR.
- **D058** Disclosure-sensitive security findings may restrict public detail while preserving access-controlled evidence.
- **D059** Suspected secrets are redacted/fingerprinted and not copied through prompts/logs/transcripts/publication unnecessarily.
- **D060** No public cancel command; cancellation remains an orchestrator lifecycle state.
- **D061** No arbitrary total wall-clock timeout initially; bound calls/retries/loops instead.
- **D062** Persisted reviews resume safely after restart without redoing completed inference.
- **D063** Multiple PRs use a durable queue with configurable global/provider concurrency and one active generation per PR.
- **D064** Transient rate limits wait/back off; actual budget/capability exhaustion yields incomplete coverage.
- **D065** Half-Shell explicitly supports local-first Ollama inference.
- **D066** Offline local workers cause durable waiting by default; cloud fallback requires explicit inference policy.
- **D067** Data egress is separately controlled and auditable; cloud receives minimum task-relevant evidence.
- **D068** Local models can be qualified per persona/capability tier through a repeatable evaluation harness.
