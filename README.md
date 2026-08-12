# Half-Shell

Half-Shell is a GitHub App concept for adversarial, multi-agent pull request review. Instead of relying on a single reviewer, Half-Shell convenes a themed review council called **The Dojo**. Each reviewer works in a defined lane, submits findings into an anonymous pool, challenges the other findings, and lets Leonardo issue the final verdict.

## Why this repo exists

This repository is the canonical home for the Half-Shell GitHub App, its review engine, provider routing, GitHub webhook handling, persistence, and council logic.

Half-Shell is intended to review PRs automatically when they are opened or updated, then continue the conversation when coding agents or developers respond to review findings.

The target workflow is:

```text
PR opened or updated
        ↓
Half-Shell GitHub App receives webhook
        ↓
Context builder gathers diff + relevant repo context
        ↓
The Dojo reviews in specialist lanes
        ↓
Anonymous findings enter Sparring
        ↓
Council members challenge/support findings
        ↓
Shredder performs the primary anti-change challenge
        ↓
Leonardo issues The Verdict
        ↓
Half-Shell posts validated findings to GitHub
        ↓
Developer/coding agent responds or pushes a fix
        ↓
Half-Shell verifies, withdraws, or continues the thread
```

## The Dojo

Half-Shell's reviewers are intentionally specialized rather than running several copies of the same generic code-review prompt.

| Member | Primary lane |
| --- | --- |
| **Leonardo** | Final arbiter. Reviews the evidence and deliberation, merges duplicate findings, rejects weak claims, and decides what Half-Shell publishes. |
| **Donatello** | Architecture, APIs, schemas, contracts, data flow, integrations, and cross-file consequences. |
| **Raphael** | Runtime bugs, regressions, incorrect logic, race conditions, state failures, and aggressive defect hunting. |
| **Michelangelo** | Product behavior, usability, completeness, maintainability, edge cases, and whether the change actually fulfills the stated intent. |
| **Splinter** | Security, authorization, permissions, engineering discipline, repository standards, and long-term risk. |
| **April** | Context and investigation. Interprets the PR description, linked issue/discussion, documentation, and intended outcome so the council understands why the change exists. |
| **Casey Jones** | QA and break-testing mindset. Looks for failure scenarios, weird user behavior, missing tests, concurrency problems, and production-style abuse cases. |
| **Shredder** | Primary anti-change adversary. Challenges proposed changes and council findings, demands evidence, searches for assumptions, and tries to prove that a finding or proposed fix is unnecessary, incomplete, or unsafe. |

## Anonymous findings

Specialists keep their assigned lanes, but findings become anonymous when they enter council deliberation.

A normalized finding should contain evidence rather than personality:

```text
Finding A17
Severity: high
Category: regression
Confidence: 0.89
Claim: ...
Evidence: ...
Suggested fix: ...
```

Other council members can support, challenge, add evidence, adjust severity, or identify related findings without knowing which specialist originally submitted the claim.

Independent discovery of the same problem is useful evidence and should not be discarded prematurely.

## Sparring

**Sparring** is Half-Shell's internal deliberation phase.

Council members inspect the anonymous finding pool and challenge one another's conclusions. Shredder is not the only critic, but Shredder has an explicit anti-change mandate:

- Why does this change need to exist?
- What existing behavior does it risk?
- Is the claimed problem actually reachable?
- Is there repository evidence for the finding?
- Could the reviewer be wrong?
- Does the suggested fix introduce more risk than it removes?
- Is there a smaller or safer change?

Shredder has no final authority. The role exists to enforce burden of proof.

## The Verdict

**The Verdict** is Leonardo's final decision after Sparring.

Leonardo should not merely count votes. The final decision should account for:

- evidence quality
- independent corroboration
- specialist relevance
- Shredder's objections
- counter-evidence
- severity
- confidence
- whether the problem was actually introduced or exposed by the PR

Possible outcomes include:

- publish finding
- reject finding
- merge related findings
- downgrade or upgrade severity
- request additional investigation
- later mark a finding verified, resolved, or withdrawn

Only findings that survive this process should become public GitHub review comments.

## GitHub App model

The source code lives in this repository, but Half-Shell itself will run as a deployed service. GitHub will send webhook events to that service when relevant repository activity occurs.

Planned event flow includes:

- pull request opened
- pull request synchronized with new commits
- draft marked ready for review
- PR conversation comments
- inline review replies
- review-thread activity
- manual Half-Shell commands

The App should be able to respond inside existing review threads so coding agents such as Claude Code, Codex, or other automation can challenge findings, explain changes, and request verification.

Example commands may eventually include:

```text
@half-shell review
@half-shell deep review
@half-shell verify
@half-shell reconsider
@half-shell explain
```

## Inference strategy

Half-Shell should remain model/provider agnostic.

Initial target routing:

```text
free cloud inference
        ↓ fallback
alternate free cloud inference
        ↓ fallback
local inference / Ollama where available
        ↓ optional future paid escalation
```

The system should optimize for high-confidence material findings rather than comment volume.

The current planning target is approximately **20 complete PR reviews on a heavy development day**, not enterprise-scale throughput.

## Design principles

- High precision over high comment volume.
- Prefer silence over speculative findings.
- Review the PR change, not unrelated pre-existing code.
- Never blindly trust LLM line numbers or findings.
- Validate findings against the actual diff before posting.
- Keep specialist lanes narrow enough to produce meaningfully different perspectives.
- Preserve anonymity during deliberation to reduce anchoring and personality/model bias.
- Let every council member challenge the shared pool.
- Keep Leonardo as the single publishing authority.
- Treat Shredder as an adversarial critic, not an automatic veto.
- Support ongoing discussion and verification after the initial review.
- Never silently use paid inference when free/local operation is expected.

## Running it

The pipeline above is implemented in `src/`. The runtime orchestrates; it does not invent review policy — it loads `skills/half-shell-review/v1/SKILL.md` and follows it.

```bash
npm ci
npm run build
npm start     # webhook listener: POST /webhook, GET /healthz
```

Review a real pull request from the terminal without posting anything:

```bash
node dist/cli.js --repo owner/name --pr 42 --installation 12345
```

Configuration lives in the environment; see [`.env.example`](./.env.example) for the GitHub App credentials, the ordered inference chain, and the review budget. Implementation details are in [`docs/architecture/pipeline.md`](./docs/architecture/pipeline.md).

## Status

**First end-to-end implementation.**

Implemented: webhook handling and signature verification, event/command routing, bounded context building, the six-phase council pipeline, diff-anchored finding validation, schema-checked structured output, provider fallback routing, GitHub publication, per-PR persistence, and follow-up verification.

Not yet implemented: retrieval of related callers and tests beyond the diff, a database-backed store, review-thread mapping across force-pushes, and rate/cost telemetry.
