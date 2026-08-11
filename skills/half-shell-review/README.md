# Half-Shell Review

The canonical review protocol behind **Half-Shell**.

Half-Shell reviews pull requests through **The Dojo**: specialized investigators independently inspect a change, their findings are anonymized into a shared pool, the council spars over the evidence, Shredder performs an explicit anti-change challenge, and Leonardo issues **The Verdict**.

## Current version

**v1**

- Protocol: [`v1/SKILL.md`](./v1/SKILL.md)
- Finding schema: [`v1/schemas/finding.schema.json`](./v1/schemas/finding.schema.json)
- Critique schema: [`v1/schemas/critique.schema.json`](./v1/schemas/critique.schema.json)
- Verdict schema: [`v1/schemas/verdict.schema.json`](./v1/schemas/verdict.schema.json)
- Resolution schema: [`v1/schemas/resolution.schema.json`](./v1/schemas/resolution.schema.json)

## Why this is versioned

The review protocol is part of the product contract. A Half-Shell run should be able to record which protocol version produced its findings instead of silently changing behavior when prompts evolve.

The GitHub App may change independently from the protocol. Breaking protocol changes should create a new version directory rather than rewriting an existing version in place.

## Integration rule

Adapters must stay thin. Do not copy the full protocol into `CLAUDE.md`, `AGENTS.md`, system prompts, or provider-specific configuration. Load the canonical `SKILL.md` and follow it.
