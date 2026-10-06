/**
 * Server-rendered HTML for Dojo v0. Every value that reaches the page —
 * persona content, finding claims, PR-derived evidence — is escaped:
 * Council content is partly derived from attacker-controlled PR input.
 * The live region (#dojo-live) is rendered by the same functions for the
 * full page and for the polling fragment, so there is one rendering path.
 */
import type { CouncilEvent, CouncilFinding, EvidencePacket, Verdict } from '../orchestration/types.js';
import { summarizeVerdict, type PublicationState, type RunDetail, type RunSummary, type VerdictSummary } from './readModel.js';

export const POLL_INTERVAL_MS = 3000;

const ACTOR_NAMES: Record<string, string> = {
  orchestrator: 'Orchestrator',
  leo: 'Leonardo',
  raph: 'Raphael',
  donnie: 'Donatello',
  mikey: 'Michelangelo',
  splinter: 'Splinter',
  april: 'April',
  casey: 'Casey',
  shredder: 'Shredder',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function actorName(actor: string): string {
  return ACTOR_NAMES[actor] ?? actor;
}

/** Restricts an actor to a safe CSS class suffix. */
function actorClass(actor: string): string {
  return actor in ACTOR_NAMES ? actor : 'unknown';
}

function time(iso: string | null | undefined): string {
  if (!iso) return '—';
  return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}">${escapeHtml(iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z'))}</time>`;
}

function badge(text: string, kind: string): string {
  return `<span class="badge badge-${escapeHtml(kind)}">${escapeHtml(text)}</span>`;
}

function statusBadge(status: string): string {
  return badge(status, status === 'running' ? 'active' : status === 'archived' ? 'ok' : 'bad');
}

function shortId(id: string): string {
  const [prefix, rest] = id.split('_', 2);
  return rest ? `${prefix}_${rest.slice(0, 8)}` : id.slice(0, 12);
}

function verdictCell(verdict: VerdictSummary | null): string {
  if (!verdict) return '<span class="muted">pending</span>';
  const kind = verdict.overallOutcome === 'blocking_findings_published'
    ? 'bad'
    : verdict.overallOutcome === 'incomplete'
      ? 'warn'
      : 'ok';
  return `${badge(verdict.overallOutcome, kind)}<div class="small">${verdict.blocking} blocking · ${verdict.nonBlocking} non-blocking · ${verdict.notPublished} not published</div>`;
}

function rawJson(id: string, label: string, value: unknown): string {
  return `<details class="raw" id="${escapeHtml(id)}"><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></details>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/dojo/assets/dojo.css">
<script src="/dojo/assets/dojo.js" defer></script>
</head>
<body>
<header class="top"><a href="/dojo"><strong>Half-Shell Dojo</strong></a> <span class="muted">v0 · local · read-only</span> <span id="dojo-poll" class="muted small"></span></header>
<main>${body}</main>
</body>
</html>`;
}

function live(active: boolean, inner: string): string {
  return `<div id="dojo-live" data-active="${active ? 'true' : 'false'}" data-poll="${POLL_INTERVAL_MS}">${inner}</div>`;
}

// --- home -----------------------------------------------------------------

export function renderHomeFragment(runs: RunSummary[], databasePath: string): string {
  const rows = runs
    .map(
      (r) => `<tr class="${r.active ? 'row-active' : ''}">
<td><a href="/dojo/runs/${encodeURIComponent(r.id)}">${escapeHtml(r.repository)}#${r.pullRequestNumber}</a></td>
<td><code title="${escapeHtml(r.id)}">${escapeHtml(shortId(r.id))}</code><div class="small">gen ${r.generation}</div></td>
<td><code title="${escapeHtml(r.headSha)}">${escapeHtml(r.shortHeadSha)}</code></td>
<td>${escapeHtml(r.phase)}</td>
<td>${statusBadge(r.status)}</td>
<td>${verdictCell(r.verdict)}</td>
<td class="small">${time(r.createdAt)}</td>
<td class="small">${time(r.updatedAt)}</td>
</tr>`,
    )
    .join('\n');
  const table = runs.length
    ? `<table class="runs"><thead><tr><th>PR</th><th>Review / gen</th><th>Head</th><th>Phase</th><th>Status</th><th>Verdict</th><th>Created</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="muted">No Council runs recorded in this database yet.</p>`;
  // The home page always polls so newly started runs appear on their own.
  return live(true, `<h1>Recent Council runs</h1><p class="small muted">Reading <code>${escapeHtml(databasePath)}</code> · newest first</p>${table}`);
}

export function renderHome(runs: RunSummary[], databasePath: string): string {
  return page('Half-Shell Dojo', renderHomeFragment(runs, databasePath));
}

export function renderMissingDatabaseFragment(databasePath: string): string {
  return live(
    true,
    `<h1>No Council database yet</h1><p>Dojo is waiting for <code>${escapeHtml(databasePath)}</code> to exist. It is created the first time Half-Shell runs with <code>HALF_SHELL_REVIEW_ENGINE=council</code>, or point <code>HALF_SHELL_COUNCIL_DATABASE_PATH</code> at an existing one.</p>`,
  );
}

export function renderMissingDatabase(databasePath: string): string {
  return page('Half-Shell Dojo', renderMissingDatabaseFragment(databasePath));
}

// --- run detail -----------------------------------------------------------

function renderEvent(event: CouncilEvent): string {
  const actor = actorClass(event.actor);
  const metadata = event.metadata && Object.keys(event.metadata).length
    ? `<div class="meta"><code>${escapeHtml(JSON.stringify(event.metadata))}</code></div>`
    : '';
  const finding = event.findingId
    ? `<a class="finding-ref" href="#${escapeHtml(event.findingId)}"><code>${escapeHtml(shortId(event.findingId))}</code></a>`
    : '';
  return `<li class="event actor-${actor}">
<div class="event-head"><span class="seq">#${event.sequence}</span> <span class="actor">${escapeHtml(actorName(event.actor))}</span> <span class="etype">${escapeHtml(event.eventType)}</span> <span class="phase">${escapeHtml(event.phase)}</span> ${finding} <span class="small muted">${time(event.createdAt)}</span></div>
${event.content ? `<div class="content">${escapeHtml(event.content)}</div>` : ''}${metadata}
</li>`;
}

function renderFindings(findings: CouncilFinding[], verdict: Verdict | null): string {
  if (!findings.length) return '<p class="muted">No findings recorded.</p>';
  const decisions = new Map((verdict?.findings ?? []).map((d) => [d.findingId, d]));
  return findings
    .map((f) => {
      const d = decisions.get(f.id);
      const where = `${f.affectedCode.file}${f.affectedCode.line != null ? `:${f.affectedCode.line}` : ''}`;
      const decision = d
        ? `<div class="decision">Leo: ${badge(d.outcome, d.outcome === 'publish' ? 'ok' : 'muted')} ${d.blocking ? badge('blocking', 'bad') : badge('non-blocking', 'muted')} ${d.finalSeverity ? badge(d.finalSeverity, 'muted') : ''}<div>${escapeHtml(d.publicReason)}</div>${d.blockingReason ? `<div class="small">Blocking reason: ${escapeHtml(d.blockingReason)}</div>` : ''}</div>`
        : '';
      return `<div class="finding actor-${actorClass(f.sourcePersona)}" id="${escapeHtml(f.id)}">
<div class="event-head"><code>${escapeHtml(shortId(f.id))}</code> <span class="actor">${escapeHtml(actorName(f.sourcePersona))}</span> ${badge(f.status, 'muted')} ${badge(f.category, 'muted')} ${f.severity ? badge(f.severity, 'muted') : ''} <span class="small">confidence ${escapeHtml(f.confidence)}</span> <code class="small">${escapeHtml(where)}</code></div>
<div class="content"><strong>${escapeHtml(f.claim)}</strong></div>
<div class="small"><em>Evidence:</em> ${escapeHtml(f.evidence)}</div>
<div class="small"><em>Consequence:</em> ${escapeHtml(f.consequence)}</div>
${decision}
</div>`;
    })
    .join('\n');
}

function renderVerdict(verdict: Verdict | null): string {
  if (!verdict) return '<p class="muted">Leo has not recorded a verdict yet.</p>';
  const uncertainty = verdict.unresolvedUncertainty.length
    ? `<div class="small"><em>Unresolved uncertainty:</em><ul>${verdict.unresolvedUncertainty.map((u) => `<li>${escapeHtml(u)}</li>`).join('')}</ul></div>`
    : '';
  return `<div class="actor-leo finding">${verdictCell(summarizeVerdict(verdict))}<div class="content">${escapeHtml(verdict.rationale)}</div>${uncertainty}<div class="small muted">${time(verdict.createdAt)}</div></div>`;
}

function renderPublication(p: PublicationState): string {
  const kind = p.state === 'published' ? 'ok' : p.state === 'in_progress' ? 'active' : p.state === 'not_started' ? 'muted' : 'bad';
  const parts = [badge(p.state, kind)];
  if (p.githubReviewOutcome) parts.push(badge(p.githubReviewOutcome, 'muted'));
  if (p.githubReviewId != null) parts.push(`<span class="small">GitHub review id ${escapeHtml(p.githubReviewId)}</span>`);
  if (p.at) parts.push(`<span class="small muted">${time(p.at)}</span>`);
  return `<p>${parts.join(' ')}</p>${p.detail ? `<p class="small">${escapeHtml(p.detail)}</p>` : ''}`;
}

function list(label: string, items: string[]): string {
  return items.length ? `<div class="small"><em>${escapeHtml(label)}:</em><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>` : '';
}

function renderEvidence(evidence: EvidencePacket | null): string {
  if (!evidence) return '<p class="muted">No evidence packet recorded yet.</p>';
  return `<div class="small"><em>Stated intent:</em> ${escapeHtml(evidence.statedIntent)}</div>
${list('Unresolved context', evidence.unresolvedContext)}
${list('Unknowns', evidence.unknowns.map((u) => (u.whyItMatters ? `${u.question} — ${u.whyItMatters}` : u.question)))}
${list('Inferences', evidence.inferences.map((i) => `${i.statement} (basis: ${i.basis})`))}
<details id="evidence-facts"><summary>${evidence.facts.length} facts · ${evidence.sources.length} sources</summary>
${list('Facts', evidence.facts.map((f) => f.statement))}
${list('Sources', evidence.sources.map((s) => `${s.kind}: ${s.reference}`))}
</details>`;
}

export function renderRunFragment(detail: RunDetail): string {
  const { run, summary } = detail;
  const header = `<p><a href="/dojo">← all runs</a></p>
<h1>${escapeHtml(summary.repository)}#${summary.pullRequestNumber} <span class="muted">gen ${summary.generation}</span></h1>
<table class="kv"><tbody>
<tr><th>Review</th><td><code>${escapeHtml(run.id)}</code></td><th>Status</th><td>${statusBadge(run.status)}${summary.active ? ' <span class="small muted">live — refreshing</span>' : ''}</td></tr>
<tr><th>Phase</th><td>${escapeHtml(run.currentPhase)}</td><th>Trigger</th><td>${escapeHtml(run.trigger)}</td></tr>
<tr><th>Head</th><td><code title="${escapeHtml(run.headSha)}">${escapeHtml(summary.shortHeadSha)}</code></td><th>Base</th><td><code title="${escapeHtml(run.baseSha)}">${escapeHtml(run.baseSha.slice(0, 7))}</code></td></tr>
<tr><th>Created</th><td>${time(run.createdAt)}</td><th>Updated</th><td>${time(run.updatedAt)}</td></tr>
<tr><th>Tokens</th><td>${run.tokenUsage.promptTokens} prompt / ${run.tokenUsage.completionTokens} completion</td><th>Superseded by</th><td>${run.supersededByReviewId ? `<a href="/dojo/runs/${encodeURIComponent(run.supersededByReviewId)}"><code>${escapeHtml(shortId(run.supersededByReviewId))}</code></a>` : '—'}</td></tr>
</tbody></table>
${run.error ? `<p class="error"><strong>Error:</strong> ${escapeHtml(run.error)}</p>` : ''}`;

  const side = `<section><h2>Leo's verdict</h2>${renderVerdict(detail.verdict)}</section>
<section><h2>Publication</h2>${renderPublication(detail.publication)}</section>
<section><h2>Findings (${detail.findings.length})</h2>${renderFindings(detail.findings, detail.verdict)}</section>
<section><h2>Evidence packet</h2>${renderEvidence(detail.evidence)}</section>`;

  const events = detail.events.length
    ? `<ol class="events">${detail.events.map(renderEvent).join('\n')}</ol>`
    : '<p class="muted">No events recorded yet.</p>';

  const debug = `<section><h2>Debug</h2>
${rawJson('raw-run', 'Raw run JSON', run)}
${rawJson('raw-verdict', 'Raw verdict JSON', detail.verdict)}
${rawJson('raw-findings', 'Raw findings JSON', detail.findings)}
${rawJson('raw-evidence', 'Raw evidence packet JSON', detail.evidence)}
${rawJson('raw-events', 'Raw events JSON', detail.events)}
</section>`;

  return live(
    summary.active,
    `${header}<div class="grid"><section class="stream"><h2>Council stream (${detail.events.length} events)</h2>${events}</section><div class="side">${side}</div></div>${debug}`,
  );
}

export function renderRun(detail: RunDetail): string {
  return page(`Dojo · ${detail.summary.repository}#${detail.summary.pullRequestNumber}`, renderRunFragment(detail));
}

export function renderNotFound(message: string): string {
  return page('Not found · Half-Shell Dojo', `<h1>Not found</h1><p>${escapeHtml(message)}</p><p><a href="/dojo">← all runs</a></p>`);
}

// --- static assets ----------------------------------------------------------

export const DOJO_CSS = `
:root { color-scheme: light dark; --fg:#1d1f21; --bg:#fbfbf8; --muted:#6b6f76; --line:#d9d9d2; --card:#fff; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6e6e3; --bg:#16181b; --muted:#9a9ea6; --line:#33363b; --card:#1e2125; } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.45 system-ui, sans-serif; color:var(--fg); background:var(--bg); }
a { color:inherit; }
header.top { padding:10px 16px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:baseline; }
main { padding:16px; max-width:1500px; margin:0 auto; }
h1 { font-size:20px; margin:4px 0 8px; } h2 { font-size:15px; margin:16px 0 8px; }
code { font:12px ui-monospace, monospace; }
.muted { color:var(--muted); } .small { font-size:12px; }
table { border-collapse:collapse; width:100%; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
table.kv { width:auto; } table.kv th { color:var(--muted); font-weight:500; }
tr.row-active { background:rgba(46,134,222,.08); }
.badge { display:inline-block; padding:1px 6px; border-radius:4px; font-size:12px; border:1px solid var(--line); }
.badge-active { background:#2e86de; color:#fff; border-color:#2e86de; }
.badge-ok { background:#2f9e44; color:#fff; border-color:#2f9e44; }
.badge-bad { background:#c92a2a; color:#fff; border-color:#c92a2a; }
.badge-warn { background:#e67700; color:#fff; border-color:#e67700; }
.grid { display:grid; grid-template-columns:minmax(0,3fr) minmax(0,2fr); gap:20px; }
@media (max-width:900px) { .grid { grid-template-columns:1fr; } }
ol.events { list-style:none; padding:0; margin:0; }
.event, .finding { background:var(--card); border:1px solid var(--line); border-left:5px solid var(--actor,#888); border-radius:4px; padding:6px 10px; margin-bottom:6px; }
.event-head { display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; }
.actor { font-weight:700; color:var(--actor,inherit); min-width:7em; }
.etype { font-family:ui-monospace, monospace; font-size:12px; }
.phase { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
.seq { color:var(--muted); font-size:12px; min-width:2.5em; }
.content { white-space:pre-wrap; margin-top:4px; }
.meta { margin-top:4px; color:var(--muted); word-break:break-all; }
.decision { margin-top:6px; padding-top:6px; border-top:1px dashed var(--line); }
.error { color:#c92a2a; }
pre { white-space:pre-wrap; word-break:break-all; font-size:12px; max-height:480px; overflow:auto; }
.actor-orchestrator { --actor:#868e96; }
.actor-leo { --actor:#1c7ed6; }
.actor-raph { --actor:#e03131; }
.actor-donnie { --actor:#7048e8; }
.actor-mikey { --actor:#f08c00; }
.actor-splinter { --actor:#8d6e63; }
.actor-april { --actor:#e6a700; }
.actor-casey { --actor:#2b8a3e; }
.actor-shredder { --actor:#495057; }
.actor-unknown { --actor:#adb5bd; }
`;

/**
 * Polls the current URL's fragment (?fragment=1) while #dojo-live says the
 * view is active, swapping the live region in place and restoring any
 * open <details> so a debug panel doesn't collapse on every refresh.
 */
export const DOJO_JS = `
(function () {
  var status = document.getElementById('dojo-poll');
  function root() { return document.getElementById('dojo-live'); }
  function schedule() {
    var r = root();
    if (!r) return;
    if (r.getAttribute('data-active') !== 'true') { if (status) status.textContent = 'not live'; return; }
    setTimeout(tick, Number(r.getAttribute('data-poll')) || 3000);
  }
  function tick() {
    var url = location.pathname + '?fragment=1';
    fetch(url, { cache: 'no-store', headers: { accept: 'text/html' } })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); })
      .then(function (html) {
        var current = root();
        if (!current) return;
        var open = Array.prototype.map.call(current.querySelectorAll('details[open][id]'), function (d) { return d.id; });
        var holder = document.createElement('div');
        holder.innerHTML = html;
        var next = holder.firstElementChild;
        if (!next) return;
        open.forEach(function (id) { var d = next.querySelector('#' + CSS.escape(id)); if (d) d.open = true; });
        current.replaceWith(next);
        if (status) status.textContent = 'live · refreshed ' + new Date().toLocaleTimeString();
      })
      .catch(function (err) { if (status) status.textContent = 'refresh failed (' + err.message + '); retrying'; })
      .then(schedule);
  }
  schedule();
})();
`;
