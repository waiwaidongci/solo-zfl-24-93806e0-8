export const opsPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>赛鸽公棚赛事运营系统</title>
<style>
  :root { --bg:#eef1f5; --panel:#fff; --ink:#1f2833; --muted:#687686; --line:#d4dde5; --accent:#2f607f; --red:#a8412f; --amber:#9a6a16; --green:#2e7048; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif; }
  header { padding:16px 26px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:14px; }
  h1 { margin:0; font-size:22px; }
  nav button, .ghost { background:#eef3f7; color:var(--accent); }
  main { padding:18px 26px; display:grid; grid-template-columns:360px 1fr; gap:18px; align-items:start; }
  .panel, form { background:#fff; border:1px solid var(--line); border-radius:10px; padding:16px; }
  h2 { margin:0 0 12px; font-size:17px; } h3 { margin:10px 0 6px; font-size:15px; }
  label { display:block; margin:9px 0 4px; color:var(--muted); font-size:13px; }
  input, select { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px 9px; font:inherit; background:#fff; }
  button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:8px 12px; font-weight:700; cursor:pointer; margin:4px 4px 0 0; }
  button.mini { padding:4px 8px; font-size:12px; font-weight:400; }
  button.danger { background:var(--red); }
  .meta { color:var(--muted); font-size:13px; }
  .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; margin-right:5px; }
  .pill.ok { color:var(--green); border-color:#bcdcc9; background:#f1f9f4; }
  .pill.warn { color:var(--amber); border-color:#e7d6ac; background:#fdf8ec; }
  .pill.bad { color:var(--red); border-color:#e4bcb3; background:#fdf2f0; }
  table { width:100%; border-collapse:collapse; font-size:13px; margin-top:8px; }
  th, td { border-bottom:1px solid var(--line); padding:7px 8px; text-align:left; white-space:nowrap; }
  th { color:var(--muted); font-weight:600; background:#f8fafb; }
  tr.cross td { background:#fdf2f0; }
  .toast { position:fixed; top:18px; left:50%; transform:translateX(-50%); border-radius:8px; padding:11px 18px; color:#fff; font-weight:700; display:none; z-index:99; max-width:80vw; }
  .toast.ok { background:var(--green); } .toast.err { background:var(--red); }
  .tabs { display:flex; gap:8px; }
  .tab.active { background:var(--accent); color:#fff; }
  #tabAudit, #tabPigeons { display:none; }
  #tabAudit { grid-column:1 / -1; }
  .race-item { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:8px; cursor:pointer; }
  .race-item.sel { border-color:var(--accent); background:#f3f8fb; }
  .denied { color:var(--red); } .success { color:var(--green); }
  code { background:#f2f5f8; border-radius:4px; padding:1px 5px; }
</style>
</head>
<body>
<header>
  <div><h1>赛鸽公棚赛事运营系统</h1><div class="meta">发布赛事 · 圈定名单 · 放飞归巢 · 分速名次 · 全程留痕</div></div>
  <div class="tabs">
    <button class="tab active" data-tab="Races">赛事运营</button>
    <button class="tab" data-tab="Pigeons">赛鸽档案</button>
    <button class="tab" data-tab="Audit">审计日志</button>
    <a class="ghost" href="/legacy" style="text-decoration:none;border-radius:6px;padding:8px 12px;font-weight:700;">旧档案入口 →</a>
  </div>
</header>
<main>
  <div id="tabRaces">
    <form id="publishForm">
      <h2>发布赛事</h2>
      <label>赛事名称</label><input name="name" required placeholder="如：2026 秋季 500 公里决赛">
      <label>比赛距离（米）</label><input name="distance" type="number" min="1" value="500000" required>
      <label>参赛棚号（逗号分隔，按棚号圈定）</label><input name="lofts" value="北岸A棚,南岸B棚" required>
      <label>放飞时间（可放飞时再填）</label><input name="releaseAt" type="datetime-local">
      <button data-testid="publish-btn">发布赛事</button>
    </form>
    <div class="panel" style="margin-top:14px;">
      <h2>赛事列表</h2>
      <div id="raceList"></div>
    </div>
  </div>

  <div id="tabPigeons" class="panel"></div>
  <div id="tabAudit" class="panel" style="grid-column:1 / -1;"></div>

  <div class="panel" id="raceDetail" style="display:none; grid-column:2;"></div>
</main>
<div class="toast" id="toast"></div>

<script>
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const localInput = d => { const x = new Date(d - d.getTimezoneOffset() * 60000).toISOString(); return x.slice(0, 16); };
const STATUS = { normal:"正常", injured:"伤病", lost:"迷失", dead:"亡故" };
let races = [], pigeons = [], currentRaceId = null;

function toast(msg, ok) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast " + (ok ? "ok" : "err"); t.style.display = "block";
  clearTimeout(t._h); t._h = setTimeout(() => t.style.display = "none", 3600);
}
async function api(path, options = {}) {
  if (options.body) { options.headers = { "Content-Type": "application/json", ...(options.headers||{}) }; }
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.message || data.error || "请求失败"); e.code = data.error; throw e; }
  return data;
}

async function loadRaces() {
  races = await api("/api/races");
  $("#raceList").innerHTML = races.map(r =>
    '<div class="race-item' + (r.id === currentRaceId ? " sel" : "") + '" data-race="' + r.id + '">'
    + '<b>' + esc(r.name) + '</b> <span class="pill ' + ({ published:"warn", released:"ok", closed:"bad" }[r.status]) + '">'
    + ({ published:"已发布", released:"已放飞", closed:"已关闭" }[r.status] || r.status) + '</span>'
    + '<div class="meta">#' + r.id + ' · ' + (r.distance_m/1000) + '公里 · ' + esc(r.allowed_lofts.join("、")) + '</div></div>').join("")
    || '<div class="meta">暂无赛事</div>';
  $$(".race-item").forEach(el => el.onclick = () => { currentRaceId = Number(el.dataset.race); loadRaces(); showRace(); });
  if (currentRaceId) showRace();
}
async function loadPigeons() {
  pigeons = await api("/api/pigeons");
  $("#tabPigeons").innerHTML = '<h2>赛鸽档案（状态异常的赛鸽不能入名单、不能报到）</h2><table>'
    + "<tr><th>足环号</th><th>鸽主</th><th>棚号</th><th>羽色</th><th>状态</th><th>状态调整</th><th>转棚/转让</th></tr>"
    + pigeons.map(p => '<tr data-ring="' + esc(p.ringNo) + '"><td><b>' + esc(p.ringNo) + '</b>' + (p.legacy ? ' <span class="pill">旧档案</span>' : "") + '</td>'
      + '<td>' + esc(p.owner) + '</td><td>' + esc(p.loft_no) + '</td><td>' + esc(p.color) + '</td>'
      + '<td><span class="pill ' + (p.status === "normal" ? "ok" : "bad") + '">' + (STATUS[p.status]||p.status) + '</span></td>'
      + '<td><select data-status="' + esc(p.ringNo) + '">' + Object.entries(STATUS).map(([k,v]) => '<option ' + (k===p.status?"selected":"") + ' value="'+k+'">'+v+'</option>').join("") + '</select> '
      + '<button class="mini" data-setstatus="' + esc(p.ringNo) + '">保存</button></td>'
      + '<td><input style="width:90px" placeholder="新棚号" data-newloft="' + esc(p.ringNo) + '"> <input style="width:90px" placeholder="新鸽主" data-newowner="' + esc(p.ringNo) + '"> '
      + '<button class="mini" data-transfer="' + esc(p.ringNo) + '">转棚</button></td></tr>').join("") + "</table>";
  $$("[data-setstatus]").forEach(b => b.onclick = async () => {
    const ring = b.dataset.setstatus;
    try { await api("/api/pigeons/" + encodeURIComponent(ring) + "/status", { method:"POST", body: JSON.stringify({ status: $('[data-status="'+ring+'"]').value }) }); toast("状态已调整并留痕", 1); loadPigeons(); }
    catch (e) { toast(e.message); }
  });
  $$("[data-transfer]").forEach(b => b.onclick = async () => {
    const ring = b.dataset.transfer;
    try {
      await api("/api/pigeons/" + encodeURIComponent(ring) + "/transfer", { method:"POST",
        body: JSON.stringify({ loft: $('[data-newloft="'+ring+'"]').value, to: $('[data-newowner="'+ring+'"]').value }) });
      toast("转棚/转让已留痕", 1); loadPigeons();
    } catch (e) { toast(e.message); }
  });
}
async function loadAudit(filter) {
  const qs = filter ? "?" + new URLSearchParams(filter) : "";
  const logs = await api("/api/audit" + qs);
  const row = l => '<tr class="' + (l.result === "denied" ? "denied" : "success") + '"><td>#' + l.id + '</td><td>' + esc(l.ts)
    + '</td><td>' + esc(l.action) + '</td><td>' + esc(l.entity_type) + ':' + esc(l.entity_id) + '</td><td>'
    + (l.result === "denied" ? '<b>拦截</b>' : "成功") + '</td><td><code>' + esc(JSON.stringify(l.detail)) + '</code></td></tr>';
  $("#tabAudit").innerHTML = '<h2>审计日志（名单、报到、排名、调整、拦截全部留痕）</h2>'
    + '<table><tr><th>#</th><th>时间</th><th>动作</th><th>对象</th><th>结果</th><th>明细</th></tr>'
    + logs.map(row).join("") + "</table>";
}

async function showRace() {
  const race = await api("/api/races/" + currentRaceId);
  const d = $("#raceDetail"); d.style.display = "block";
  const statusBadge = '<span class="pill ' + ({ published:"warn", released:"ok", closed:"bad" }[race.status]) + '">'
    + ({ published:"已发布", released:"已放飞", closed:"已关闭" }[race.status]) + "</span>";
  const ops = [];
  if (race.status === "published") {
    ops.push('<h3>圈定参赛名单</h3><div class="meta">按参赛棚号从已登记赛鸽自动圈定；状态异常者自动剔除并记录。</div>'
      + '<button data-testid="select-roster-btn" data-act="roster">按公布棚号圈定名单</button>');
    ops.push('<h3>记录放飞时间</h3><input type="datetime-local" id="releaseTime" value="' + localInput(new Date()) + '">'
      + '<button data-testid="release-btn" data-act="release">记录放飞</button>');
  }
  if (race.status === "released") {
    ops.push('<h3>归巢报到</h3><label>足环号</label><input id="arriveRing" placeholder="CHN-2026-101">'
      + '<label>实际归巢时间</label><input type="datetime-local" id="arriveTime" value="' + localInput(new Date(Date.now() + 3e7)) + '">'
      + '<button data-testid="arrival-btn" data-act="arrival">报到并计算名次</button>');
    ops.push('<button class="danger" data-act="close">关闭赛事报到通道</button>');
  }
  if (race.status === "closed") ops.push('<div class="meta">赛事已关闭，报到通道不可用；历史名次保留。</div>');

  const entryRows = race.entries.map(e => {
    const cross = e.roster_loft !== e.current_loft;
    return '<tr class="' + (cross ? "cross" : "") + '"><td><b>' + esc(e.ring_no) + '</b></td><td>' + esc(e.owner) + '</td>'
      + '<td>' + esc(e.roster_loft) + '</td><td>' + esc(e.current_loft) + (cross ? ' ⚠跨棚' : '') + '</td>'
      + '<td><span class="pill ' + (e.status === "normal" ? "ok" : "bad") + '">' + (STATUS[e.status]||e.status) + '</span></td>'
      + '<td>' + (e.arrived_at ? esc(e.arrived_at.replace("T"," ").slice(0,19)) : "—") + '</td>'
      + '<td>' + (e.rank ?? "—") + '</td><td>' + (e.speed_m_per_min ?? "—") + '</td>'
      + (e.arrived_at ? '<td><button class="mini" data-void="' + esc(e.ring_no) + '">作废</button></td>' : '<td></td>') + '</tr>';
  }).join("");
  const rankRows = race.arrivals.map(a => '<tr><td><b>' + a.rank + '</b></td><td>' + esc(a.ring_no) + '</td><td>' + esc(a.owner)
    + '</td><td>' + esc(a.loft_no) + '</td><td>' + esc(a.arrived_at.replace("T"," ").slice(0,19)) + '</td><td>' + a.speed_m_per_min + '</td></tr>').join("");
  const auditRows = race.audit.map(l => '<tr class="' + (l.result === "denied" ? "denied" : "") + '"><td>#' + l.id + ' ' + esc(l.ts)
    + '</td><td>' + esc(l.action) + '</td><td>' + (l.result === "denied" ? '<b>拦截：</b>' : "") + esc(JSON.stringify(l.detail)) + '</td></tr>').join("");

  d.innerHTML = '<h2>' + esc(race.name) + " " + statusBadge + "</h2>"
    + '<div class="meta">距离 ' + race.distance_m + ' 米 · 参赛棚号 ' + esc(race.allowed_lofts.join("、"))
    + '<br>放飞时间：' + esc(race.release_at ? race.release_at.replace("T"," ").slice(0,19) : "未记录")
    + ' · 入选 ' + race.entries.length + ' 羽 · 归巢 ' + race.arrivals.length + ' 羽</div>'
    + ops.join("")
    + '<h3>参赛名单</h3><table><tr><th>足环号</th><th>鸽主</th><th>名单棚号</th><th>当前棚号</th><th>状态</th><th>归巢时间</th><th>名次</th><th>分速(米/分)</th><th></th></tr>' + entryRows + "</table>"
    + '<h3>实时排名</h3><table><tr><th>名次</th><th>足环号</th><th>鸽主</th><th>棚号</th><th>归巢时间</th><th>分速(米/分)</th></tr>' + rankRows + "</table>"
    + '<h3>本赛事审计（含拦截记录）</h3><table><tr><th># / 时间</th><th>动作</th><th>明细</th></tr>' + auditRows + "</table>";

  d.querySelector('[data-act="roster"]')?.addEventListener("click", async () => {
    try { const r = await api("/api/races/" + race.id + "/roster", { method:"POST", body: JSON.stringify({ lofts: race.allowed_lofts }) });
      toast("圈定完成：入选 " + r.added.length + " 羽，剔除异常 " + r.skipped.length + " 羽", 1); showRace(); }
    catch (e) { toast(e.message); }
  });
  d.querySelector('[data-act="release"]')?.addEventListener("click", async () => {
    try { await api("/api/races/" + race.id + "/release", { method:"POST", body: JSON.stringify({ releaseAt: $("#releaseTime").value }) });
      toast("放飞时间已记录", 1); loadRaces(); } catch (e) { toast(e.message); }
  });
  d.querySelector('[data-act="arrival"]')?.addEventListener("click", async () => {
    try { const a = await api("/api/races/" + race.id + "/arrivals", { method:"POST", body: JSON.stringify({ ringNo: $("#arriveRing").value.trim(), arrivedAt: $("#arriveTime").value }) });
      toast("报到成功：" + a.ring_no + " 第 " + a.rank + " 名，分速 " + a.speed + " 米/分", 1); showRace(); }
    catch (e) { toast(e.message); }
  });
  d.querySelector('[data-act="close"]')?.addEventListener("click", async () => {
    try { await api("/api/races/" + race.id + "/close", { method:"POST" }); toast("赛事已关闭", 1); loadRaces(); } catch (e) { toast(e.message); }
  });
  $$("[data-void]").forEach(b => b.onclick = async () => {
    const reason = prompt("作废原因（调整动作留痕）：", "裁判组更正");
    if (reason === null) return;
    try { await api("/api/races/" + race.id + "/arrivals/" + encodeURIComponent(b.dataset.void) + "/void", { method:"POST", body: JSON.stringify({ reason }) });
      toast("成绩已作废，名次已重算并留痕", 1); showRace(); } catch (e) { toast(e.message); }
  });
}

$("#publishForm").onsubmit = async ev => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  try {
    const race = await api("/api/races", { method:"POST", body: JSON.stringify({
      name: f.get("name"), distance: Number(f.get("distance")),
      lofts: f.get("lofts").split(/[,，]/).map(s => s.trim()).filter(Boolean),
      releaseAt: f.get("releaseAt") || null }) });
    toast("赛事 #" + race.id + " 已发布", 1); ev.target.reset(); currentRaceId = race.id; loadRaces();
  } catch (e) { toast(e.message); }
};
$$(".tab").forEach(b => b.onclick = () => {
  $$(".tab").forEach(x => x.classList.remove("active")); b.classList.add("active");
  const name = b.dataset.tab;
  $("#tabRaces").style.display = name === "Races" ? "block" : "none";
  $("#raceDetail").style.display = name === "Races" && currentRaceId ? "block" : "none";
  $("#tabPigeons").style.display = name === "Pigeons" ? "block" : "none";
  $("#tabAudit").style.display = name === "Audit" ? "block" : "none";
  if (name === "Pigeons") loadPigeons();
  if (name === "Audit") loadAudit();
});
loadRaces();
</script>
</body>
</html>`;
