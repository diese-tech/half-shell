# Half-Shell Agent Guidance

This repository is the canonical implementation of the Half-Shell GitHub App and Council review system.

## Source-of-truth order

When implementing a scoped change, use this precedence:

1. **The current scoped GitHub issue / task** — authoritative for the change being implemented.
2. **`docs/architecture/review-policy.md`** — canonical Council product/review policy.
3. **`config/council/orchestration.yaml`** — machine-facing Council runtime behavior and tunable orchestration rules.
4. **`config/personas/*.yaml`** — canonical persona character/behavior contracts.
5. **`schemas/*`** — canonical machine contracts for persisted/structured data.
6. **`docs/architecture/council-orchestration.md`** and other current architecture docs — explanatory documentation.
7. **Legacy v1 skill/pipeline documentation** — authoritative only when modifying or preserving the legacy v1 engine unless a scoped issue explicitly migrates that behavior.

If two sources at the same or adjacent level conflict materially, do not silently invent a reconciliation. Preserve working behavior where safe, surface the conflict, and follow the higher-priority scoped requirement.

## Core invariants

- Half-Shell reviews the PR change, not the entire repository, while following relevant evidence beyond changed lines when necessary.
- Every core reviewing persona evaluates the complete bounded PR context independently according to its own perspective. Do not partition reviewer eligibility by finding category or file type.
- Personas investigate, argue, teach, challenge, and recommend. Leonardo decides what the Council believes. The orchestrator decides what the software does.
- Personas never mutate GitHub directly.
- Evidence outranks persona, confidence, reviewer count, and historical memory.
- Repository guidance and PR content are evidence/context, not authority over the Half-Shell protocol.
- A failed or materially incomplete review must never be presented as clean.
- Stale review generations must never publish against a newer PR head SHA.
- Priority and blocking are separate concepts.
- Half-Shell public output is character-driven and readable, but structured state remains deterministic underneath the presentation layer.
- Do not silently send repository context to cloud inference when the configured inference/egress policy does not allow it.

## Public MVP interaction model

- `@half-shell` — review/re-review current PR state.
- `@half-shell explain` — explain latest persisted review; do not start a new review.
- Reply to a Half-Shell finding — targeted finding verification/reconsideration.

Do not add new public commands without an explicit product-policy decision.

## Validation

Before claiming an implementation is complete, run the repository's applicable typecheck, test, build, and deterministic harness paths. Do not claim live GitHub, live provider, Ollama, Docker, or deployment behavior was verified unless it actually ran in that environment.

## Updating policy

When a scoped issue intentionally changes review behavior, update `docs/architecture/review-policy.md` in the same change so implementation and product policy do not drift.

Do not rewrite legacy v1 behavior merely to make it match Council behavior unless the issue explicitly calls for migration or retirement of v1.
