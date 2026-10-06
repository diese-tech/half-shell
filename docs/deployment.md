# Deploying Half-Shell

Half-Shell is a stateless HTTP service plus a small amount of finding state.
It needs one public URL, a GitHub App, and at least one inference provider.

## 1. Register the GitHub App

Create the App at **Settings → Developer settings → GitHub Apps → New**, using
[`app-manifest.yml`](../app-manifest.yml) as the checklist for the form. That
file is not machine-consumable: GitHub's App-manifest flow takes a JSON
manifest POSTed from an HTML form, and Half-Shell implements no
manifest-conversion endpoint.

| Setting | Value |
| --- | --- |
| Webhook URL | `https://your-host/webhook` |
| Webhook secret | a random string; also set as `GITHUB_WEBHOOK_SECRET` |
| Permissions | pull requests: read & write · contents: read · issues: read & write · metadata: read |
| Events | `pull_request`, `issue_comment`, `pull_request_review_comment` |

Then generate a private key, note the App ID, and install the App on the
repositories it should review.

`contents: read` is what lets the council see linked tests and callers beyond
the diff, and the repository's own `CLAUDE.md` / `AGENTS.md` instructions.

## 2. Configure

Copy [`.env.example`](../.env.example) and fill in:

```bash
GITHUB_APP_ID=...
GITHUB_PRIVATE_KEY=...        # PEM contents, raw or base64
GITHUB_WEBHOOK_SECRET=...
GITHUB_APP_LOGIN=your-app[bot]

HALF_SHELL_PROVIDERS=groq,openrouter,ollama
HALF_SHELL_PROVIDER_GROQ_API_KEY=...
```

`HALF_SHELL_PROVIDERS` is an ordered fallback chain. Providers marked `paid`
are skipped entirely unless `HALF_SHELL_ALLOW_PAID_INFERENCE=true`.

### Review engine

`HALF_SHELL_REVIEW_ENGINE` selects which review pipeline handles an accepted
webhook review job: `v1` (default, the existing pipeline) or `council` (the
Council orchestration engine, `src/orchestration/`). An unrecognized value
fails startup immediately rather than silently falling back. `v1` stays
available and fully functional regardless of this setting — switching to
`council` is a deliberate opt-in, not a cutover; see
`docs/architecture/council-orchestration.md` for what the council engine
does differently. `council` mode also reads `HALF_SHELL_PERSONAS_DIR`
(default `config/personas`) and `HALF_SHELL_COUNCIL_DATABASE_PATH` (default
`<HALF_SHELL_DATA_DIR>/council.db`).

For anything longer-lived than a container, set `HALF_SHELL_STORE=sqlite`. The
default file store keeps one JSON file per pull request and is fine for a
single instance.

**Leave `HALF_SHELL_DATA_DIR` and `HALF_SHELL_DATABASE_PATH` unset when running
the container.** The image points both at `/data`, which is the mounted volume
and the only directory the non-root runtime user can write. Supplying them
through `--env-file` overrides the image and resolves storage to a relative
path under a root-owned working directory: the file store then logs an error
per write and discards all finding state, and the sqlite store fails to start
at all.

## 3. Run

```bash
docker build -t half-shell .
docker run -p 3000:3000 --env-file .env -v half-shell-data:/data half-shell
```

Without Docker:

```bash
npm ci && npm run build && npm start
```

`GET /healthz` returns the configured provider chain and is what the container
healthcheck uses. `POST /webhook` takes GitHub deliveries and rejects anything
whose `x-hub-signature-256` does not verify.

## 4. Verify before pointing GitHub at it

Run the whole pipeline against stub servers — no credentials, no network:

```bash
npm run build && npm run harness
```

That prints the review Half-Shell would post. To dry-run a real pull request
without writing anything to GitHub:

```bash
HALF_SHELL_DRY_RUN=true node dist/cli.js --repo owner/name --pr 42 --installation 12345
```

## Dojo v0: local Council viewer

A minimal operator/debugging view of Council runs while they happen. It reads
the same SQLite database the service writes when
`HALF_SHELL_REVIEW_ENGINE=council` — there is no separate transcript store.

```bash
npm run dojo
# Half-Shell Dojo (read-only): http://127.0.0.1:3001/dojo
```

- **Which database.** `HALF_SHELL_COUNCIL_DATABASE_PATH`, falling back to
  `<HALF_SHELL_DATA_DIR>/council.db` (default `.half-shell/council.db`) — the
  same resolution the service uses, so run it with the same environment. If the
  file does not exist yet, the page says so and picks it up once it appears.
- **What it shows.** Recent runs newest-first (repository, PR, review ID and
  generation, short head SHA, phase, status, Leo's verdict with blocking /
  non-blocking counts, timestamps). A run's page shows the ordered Council event
  stream with each actor named, current findings with Leo's per-finding
  decision, the verdict, GitHub publication state, the evidence packet, and raw
  JSON behind disclosures. Pages for active runs poll every 3 seconds.
- **Read-only.** The database is opened with SQLite's own read-only flag; the
  server answers only `GET`/`HEAD` on fixed routes (no SQL or query input) and
  has no code path to trigger reviews, change findings or verdicts, or call
  GitHub.
- **Localhost only.** Binds `127.0.0.1:3001` by default
  (`HALF_SHELL_DOJO_HOST`, `HALF_SHELL_DOJO_PORT`) and rejects requests whose
  `Host` header is not loopback. Dojo v0 has **no authentication** and
  transcripts can contain private-repository content, so a non-loopback host
  refuses to start unless `HALF_SHELL_DOJO_ALLOW_REMOTE=true` is also set, and
  then logs a warning. This is not the access-controlled transcript viewer
  described in review-policy.md section 5.
- **Docker.** The container writes `/data/council.db` on its volume; run Dojo
  on a host that can read that file (for example a bind mount) rather than
  publishing a port from inside the container.

## Local Council on Ollama (`npm run local`)

One command for a local Council session on your own machine (Windows, macOS
or Linux):

```bash
npm run local               # Ollama + Dojo + webhook service (needs GitHub App creds in .env)
npm run local -- --harness  # Ollama + Dojo + one sample Council review, no credentials
```

It loads `./.env` if present, then fills in local defaults for anything unset:
`HALF_SHELL_REVIEW_ENGINE=council`, `HALF_SHELL_PROVIDERS=ollama`,
`HALF_SHELL_PROVIDER_OLLAMA_MODEL=qwen2.5-coder:14b`,
`HALF_SHELL_PROVIDER_OLLAMA_BASE_URL=http://127.0.0.1:11434/v1`.

- **Ollama.** If nothing answers at that URL and it is a loopback address,
  the launcher runs `ollama serve` (Ollama must be installed and on `PATH`),
  waits for it, checks the model is already pulled, and preloads it into
  memory so the first persona turn isn't also the model-load. It never pulls a
  model and never starts anything for a non-local URL. If Ollama was already
  running, it is reused and left running on exit.
- **Dojo** starts on `http://127.0.0.1:3001/dojo` against the same Council
  database.
- **Webhook service** starts only when `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`
  and `GITHUB_WEBHOOK_SECRET` are set; GitHub still needs a public URL (a
  tunnel) to deliver webhooks to it. Without them, use `--harness`.
- **`--harness`** runs one sample Council review against stub GitHub and your
  real Ollama model, written to the Dojo database
  (`HALF_SHELL_HARNESS_COUNCIL_DATABASE_PATH`), then leaves Dojo running.
- **Ctrl+C** stops Dojo, the service, and the Ollama server only if this
  launcher started it.

## Operating notes

- **Scale.** One instance serializes work per pull request; separate PRs run
  concurrently. The planning target is roughly 20 complete reviews per day, and
  a review costs about 15 provider calls.
- **Cost.** Every run records duration, provider calls and token counts.
  `@half-shell explain` on a pull request prints them.
- **Shutdown.** `SIGTERM` stops accepting deliveries and drains reviews already
  in flight, up to 30 seconds.
- **Failure.** A provider chain that fails a phase degrades the verdict rather
  than faking one: the review is marked incomplete and publishes nothing.
- **Rate limits.** Rate limiting — 429, and the two 403 forms — is retried with
  backoff on any request, honouring `Retry-After`, because GitHub rejects those
  before acting on them. A 5xx or a lost connection is retried only for reads:
  a write may already have been applied, and a duplicate review is worse than a
  missing one.
- **A lost write loses that run's review.** The finding is not recorded as
  published, so the next push or an explicit `@half-shell review` posts it.
- **Related context.** Gathering it is bounded by `HALF_SHELL_MAX_RELATED_LOOKUPS`
  (default 30 GitHub requests per review), and caller search stops for the rest
  of the run after its first rejection. Set `HALF_SHELL_SEARCH_CALLERS=false` to
  skip that lookup entirely — it is a full-text basename match, not call-graph
  analysis.
