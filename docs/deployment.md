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
