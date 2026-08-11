# Half-Shell Review Protocol Architecture

Half-Shell separates **review policy** from **runtime implementation**.

## Protocol layer

`skills/half-shell-review/v1/` defines how The Dojo reasons:

```text
Briefing
  ↓
Independent specialist lanes
  ↓
Anonymous finding pool
  ↓
Council Sparring
  ↓
Shredder Challenge
  ↓
Leonardo Verdict
  ↓
Published GitHub findings
```

This layer should remain portable across Claude, Codex, free cloud models, local models, and future providers.

## Runtime layer

The eventual GitHub App is responsible for orchestration rather than inventing review policy. It should:

- gather PR context
- invoke specialists independently
- normalize and anonymize findings
- validate schema output
- coordinate Sparring
- execute Shredder's challenge pass
- invoke Leonardo for adjudication
- map approved findings to GitHub lines/threads
- persist finding and resolution state
- route follow-up replies back through targeted verification

## Why authorship is hidden

Persona specialization is useful during investigation, but identity should not become evidence during deliberation. An anonymous pool reduces anchoring while preserving independent corroboration as a useful signal.

## Why Shredder is separate

All members are allowed to criticize findings. Shredder is not the only critic and has no veto. His unique function is to apply a deliberate anti-change prior after normal peer critique, forcing the council to prove necessity, attribution, and failure paths before Leonardo publishes anything.

## Versioning

Every review run should persist the protocol version used. Breaking changes create a new protocol directory rather than silently changing prior review behavior.
