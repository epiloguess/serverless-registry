// Simple admin dashboard for the registry.
// Served at /admin, protected by the registry's Basic auth (reuses the same
// credential check as every other registry request).

const adminPage = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Registry Admin</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 24px; max-width: 1100px; margin: auto; background: #0d1117; color: #e6edf3; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .subtitle { color: #8b949e; margin: 0 0 20px; font-size: 0.9rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px 16px; }
  .card .label { color: #8b949e; font-size: 0.8rem; text-transform: uppercase; letter-spacing: .05em; }
  .card .value { font-size: 1.6rem; font-weight: 600; margin-top: 4px; }
  .panel { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  .panel h2 { font-size: 1rem; margin: 0 0 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 8px 10px; text-align: left; font-size: 0.88rem; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 500; }
  code { font-size: 0.82rem; word-break: break-all; color: #a5d6ff; }
  .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .bar-label { width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.85rem; }
  .bar-track { flex: 1; background: #21262d; border-radius: 4px; height: 16px; overflow: hidden; }
  .bar-fill { height: 100%; background: linear-gradient(90deg, #1f6feb, #58a6ff); border-radius: 4px; min-width: 2px; }
  .bar-count { width: 60px; text-align: right; font-size: 0.85rem; color: #8b949e; }
  .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 20px; }
  button, select, input { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 7px 12px; font-size: 0.88rem; }
  button:hover { background: #30363d; }
  button.primary { background: #1f6feb; border-color: #1f6feb; }
  button.danger { background: #da3633; border-color: #da3633; }
  #status { margin: 0 0 16px; padding: 10px 14px; border-radius: 6px; display: none; font-size: 0.9rem; }
  #status.ok { display: block; background: #2ea04333; border: 1px solid #2ea043; }
  #status.err { display: block; background: #f8514933; border: 1px solid #f85149; }
  .muted { color: #8b949e; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; background: #1f6feb33; color: #58a6ff; }
  .badge.stale { background: #da363333; color: #ff7b72; }
  .empty { color: #8b949e; font-size: 0.9rem; }
</style>
</head>
<body>
<h1>Registry Admin</h1>
<p class="subtitle">serverless-registry · <span id="host"></span></p>
<div id="status"></div>
<div class="actions">
  <button onclick="refreshAll()">Refresh</button>
  <span class="muted">|</span>
  <label class="muted" style="font-size:0.85rem">Prune repos idle &gt;</label>
  <input id="days" type="number" value="90" min="1" style="width:70px">
  <select id="repo-select" style="min-width:200px"></select>
  <button class="danger" onclick="prune()">Prune stale</button>
</div>
<div id="content"><p class="muted">Loading...</p></div>
<script>
const $ = (id) => document.getElementById(id);
const show = (msg, ok = true) => {
  const s = $("status");
  s.textContent = msg;
  s.className = ok ? "ok" : "err";
  setTimeout(() => { s.style.display = "none"; }, 6000);
};
async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let text = "";
    try { text = (await res.json()).error || ""; } catch {}
    throw new Error("HTTP " + res.status + (text ? ": " + text : ""));
  }
  return res.json();
}
const fmtTime = (ms) => ms ? new Date(ms).toLocaleString() : "never";
const fmtDur = (ms) => {
  if (!ms) return "never";
  const d = (Date.now() - ms) / 86400000;
  if (d < 1) return Math.round(d * 24) + "h ago";
  if (d < 30) return Math.round(d) + "d ago";
  if (d < 365) return Math.round(d / 30) + "mo ago";
  return (d / 365).toFixed(1) + "y ago";
};
function bars(items, labelFn, countFn) {
  const max = Math.max(1, ...items.map(countFn));
  return '<div class="panel"><h2>Top by pulls</h2>' + items.map((it, i) =>
    '<div class="bar-row"><span class="bar-label">' + labelFn(it, i) + '</span>' +
    '<div class="bar-track"><div class="bar-fill" style="width:' + (countFn(it) / max * 100) + '%"></div></div>' +
    '<span class="bar-count">' + countFn(it) + '</span></div>'
  ).join("") + "</div>";
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
async function refreshAll() {
  const content = $("content");
  content.innerHTML = '<p class="muted">Loading...</p>';
  try {
    const [catalog, summaryRes] = await Promise.all([
      api("/v2/_catalog?n=1000"),
      api("/v2/_admin/summary").catch(() => null),
    ]);
    const repos = catalog.repositories || [];
    const summaries = summaryRes?.repositories || [];

    const totalPulls = summaries.reduce((a, r) => a + r.totalPulls, 0);
    const totalDigests = summaries.reduce((a, r) => a + r.digestCount, 0);
    const staleCount = summaries.filter((r) => r.lastAccess < Date.now() - 30 * 86400000).length;

    const cards = [
      ["Repositories", repos.length],
      ["Tracked digests", totalDigests],
      ["Total pulls", totalPulls],
      ["Repos idle 30d+", staleCount],
    ].map(([label, value]) =>
      '<div class="card"><div class="label">' + label + '</div><div class="value">' + value + "</div></div>"
    ).join("");

    let html = '<div class="cards">' + cards + "</div>";

    const topRepos = summaries.slice(0, 8);
    if (topRepos.length > 0) {
      html += bars(topRepos, (r) => esc(r.name), (r) => r.totalPulls);
    }

    const sel = $("repo-select");
    sel.innerHTML = repos.map((r) => '<option value="' + esc(r) + '">' + esc(r) + "</option>").join("");

    if (repos.length === 0) {
      html += '<p class="empty">No repositories yet. Push an image to get started.</p>';
      content.innerHTML = html;
      return;
    }

    html += '<div class="panel"><h2>Repositories</h2><table><thead><tr>' +
      "<th>Repository</th><th>Digests</th><th>Pulls</th><th>Last access</th><th></th></tr></thead><tbody>";
    for (const repo of repos) {
      const sum = summaries.find((s) => s.name === repo);
      let hot = [];
      try {
        const h = await api("/v2/_admin/hot?name=" + encodeURIComponent(repo) + "&limit=5");
        hot = h.stats || [];
      } catch {}
      const topDigest = hot[0];
      const stale = sum && sum.lastAccess < Date.now() - 30 * 86400000;
      html += "<tr><td>" + esc(repo) + "</td>" +
        "<td>" + (sum ? sum.digestCount : hot.length) + "</td>" +
        "<td>" + (sum ? sum.totalPulls : 0) + "</td>" +
        "<td>" + fmtDur(sum ? sum.lastAccess : 0) + (stale ? ' <span class="badge stale">stale</span>' : "") + "</td>" +
        "<td>" + (topDigest ? '<span class="badge">top: ' + topDigest.count + " pulls</span>" : '<span class="muted">no stats</span>') + "</td></tr>";
    }
    html += "</tbody></table></div>";

    if (summaries.length > 0) {
      const sorted = [...summaries].sort((a, b) => b.totalPulls - a.totalPulls);
      html += bars(sorted.slice(0, 8), (r) => esc(r.name), (r) => r.totalPulls);
    }

    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = "";
    show("Failed: " + e.message, false);
  }
}
async function prune() {
  const name = $("repo-select").value;
  const days = parseInt($("days").value, 10) || 90;
  if (!name) { show("No repository selected", false); return; }
  if (!confirm("Delete manifests in '" + name + "' not accessed for " + days + " days?")) return;
  try {
    const body = await api("/v2/_admin/prune?name=" + encodeURIComponent(name) + "&days=" + days, { method: "POST" });
    show("Pruned " + (body.deleted || []).length + " manifest(s) from " + name + ", GC ran");
    refreshAll();
  } catch (e) {
    show("Prune failed: " + e.message, false);
  }
}
$("host").textContent = location.host;
refreshAll();
</script>
</body>
</html>`;

export function adminHandler(): Response {
  return new Response(adminPage, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
