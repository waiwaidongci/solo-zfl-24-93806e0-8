export function renderApp() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>赛鸽公棚赛事运营系统</title>
<style>
:root { --bg:#eef1f4; --panel:#fff; --ink:#1c2733; --muted:#667788; --line:#d5dee6; --accent:#2f6084; --accent2:#274d6b; --ok:#2e7d4f; --warn:#a06a1c; --red:#a33a30; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif; font-size:14px; }
header { background:linear-gradient(120deg,#274d6b,#2f6084); color:#fff; padding:16px 26px; display:flex; justify-content:space-between; align-items:center; }
header h1 { margin:0; font-size:21px; } header a { color:#ffe9b8; text-decoration:none; font-size:13px; }
nav { display:flex; gap:4px; background:#fff; padding:0 20px; border-bottom:1px solid var(--line); position:sticky; top:0; z-index:5; }
nav button { border:0; background:none; padding:14px 18px; font:inherit; cursor:pointer; color:var(--muted); border-bottom:3px solid transparent; }
nav button.active { color:var(--accent); border-bottom-color:var(--accent); font-weight:700; }
main { padding:20px 26px; max-width:1200px; margin:0 auto; }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px; margin-bottom:16px; }
.panel h2 { margin:0 0 14px; font-size:17px; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
label { display:block; margin:9px 0 4px; color:var(--muted); font-size:13px; }
input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px 10px; font:inherit; background:#fff; }
button.primary { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 16px; font-weight:700; cursor:pointer; margin-top:14px; }
button.ghost { border:1px solid var(--line); background:#fff; border-radius:6px; padding:6px 10px; cursor:pointer; font:inherit; }
button.danger { border:1px solid #e3c4c0; background:#fbf0ef; color:var(--red); border-radius:6px; padding:6px 10px; cursor:pointer; font:inherit; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th,td { border-bottom:1px solid var(--line); padding:8px 10px; text-align:left; white-space:nowrap; }
th { background:#f6f9fb; color:var(--muted); font-weight:600; }
tr:hover td { background:#fafcfe; }
.tag { display:inline-block; border-radius:999px; padding:2px 9px; font-size:12px; border:1px solid var(--line); }
.tag.draft { color:var(--warn); border-color:#e5d3ae; background:#fdf7ea; }
.tag.released { color:var(--ok); border-color:#b8dbc7; background:#eef8f2; }
.tag.closed { color:var(--muted); }
.tag.bad { color:var(--red); border-color:#e3c4c0; background:#fbf0ef; }
.toast { position:fixed; right:22px; bottom:22px; min-width:260px; max-width:420px; border-radius:8px; padding:12px 16px; color:#fff; box-shadow:0 6px 22px rgba(0,0,0,.18); z-index:50; opacity:0; transform:translateY(8px); transition:.2s; pointer-events:none; }
.toast.show { opacity:1; transform:none; }
.toast.ok { background:var(--ok); } .toast.err { background:var(--red); }
.muted { color:var(--muted); } .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.loft-chip { display:inline-block; border:1px solid var(--accent); color:var(--accent); border-radius:999px; padding:4px 11px; margin:3px; cursor:pointer; background:#fff; user-select:none; }
.loft-chip.on { background:var(--accent); color:#fff; }
.medal { font-weight:700; } .medal.r1 { color:#d4a017; } .medal.r2 { color:#8a97a5; } .medal.r3 { color:#b07942; }
.kv { display:grid; grid-template-columns:110px 1fr; gap:6px 10px; font-size:13px; }
.kv dt { color:var(--muted); } .kv dd { margin:0; }
code { background:#f2f5f8; padding:1px 5px; border-radius:4px; font-size:12px; }
#toast-wrap{}
</style>
</head>
<body>
<header>
  <h1>🕊 赛鸽公棚赛事运营系统</h1>
  <a href="/legacy">旧档案入口（血统登记站）→</a>
</header>
<nav id="nav">
  <button data-tab="races" class="active">赛事</button>
  <button data-tab="detail">赛事操作</button>
  <button data-tab="checkin">归巢报到</button>
  <button data-tab="rank">成绩与排名</button>
  <button data-tab="pigeons">赛鸽名册</button>
  <button data-tab="audit">审计日志</button>
</nav>
<main id="main"></main>
<div id="toast-wrap"></div>

<script>
const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];
let pigeons = [], races = [], currentRaceId = null, tab = "races";

function toast(msg, ok=true) {
  const el = document.createElement("div");
  el.className = "toast show " + (ok ? "ok" : "err");
  el.textContent = msg;
  $("#toast-wrap").appendChild(el);
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 3200);
}

const ERROR_CN = {
  race_name_required:"赛事名称不能为空", distance_invalid:"赛事距离必须为正数",
  lofts_required:"至少选择一个棚号", race_locked:"赛事已放飞或关闭，名单不可修改",
  entry_exists:"该鸽已在参赛名单中", entry_not_found:"该鸽不在参赛名单中",
  race_already_released:"已记录放飞时间", entries_empty:"名单为空，不能放飞",
  release_time_invalid:"放飞时间格式不正确", race_not_released:"赛事尚未放飞，不能报到",
  arrive_time_invalid:"归巢时间格式不正确", arrive_before_release:"归巢时间早于放飞时间",
  pigeon_not_found:"赛鸽未登记", pigeon_not_in_entries:"拦截：该鸽未入选本次赛事",
  pigeon_abnormal:"拦截：赛鸽状态异常，禁止报到/入选", duplicate_checkin:"拦截：该鸽已报到，禁止重复报到",
  cross_loft_result:"拦截：跨棚成绩（申报棚号与登记棚号不符）",
  checkin_not_found:"没有该鸽的报到记录", status_invalid:"状态值不合法",
  race_not_found:"赛事不存在", race_already_closed:"赛事已关闭",
};

async function api(path, options={}) {
  const opts = options.body ? { ...options, method:options.method||"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(options.body) } : options;
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data && data.error === "duplicate_checkin") { /* keep code */ }
    throw Object.assign(new Error((data && ERROR_CN[data.error]) || (data && data.message) || "请求失败"), { code: data && data.error });
  }
  return data;
}
async function refresh() {
  [pigeons, races] = await Promise.all([api("/api/pigeons"), api("/api/races")]);
  if (!currentRaceId && races.length) currentRaceId = races[races.length-1].id;
  render();
}
function nowLocalInput(d=new Date()) {
  const p = n => String(n).padStart(2,"0");
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+"T"+p(d.getHours())+":"+p(d.getMinutes());
}
function esc(s){ return String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function statusTag(p){ return (p.status && p.status!=="正常") ? '<span class="tag bad">'+esc(p.status)+'</span>' : '<span class="tag">正常</span>'; }
function raceTag(r){ const m={draft:"草稿",released:"已放飞",closed:"已关闭"}; return '<span class="tag '+r.status+'">'+m[r.status]+'</span>'; }
function currentRace(){ return races.find(r=>r.id===currentRaceId) || null; }

// ---------- 各标签页 ----------
function viewRaces() {
  const rows = races.slice().reverse().map(r => '<tr><td><b>'+esc(r.id)+'</b></td><td>'+esc(r.name)+'</td><td>'+r.distance+' 公里</td><td>'+esc(r.releasePoint||"—")+'</td><td>'+raceTag(r)+'</td><td>'+(r.releaseAt ? esc(new Date(r.releaseAt).toLocaleString("zh-CN")) : "—")+'</td><td>'+r.entries.length+'</td><td>'+r.checkins.length+'</td><td><button class="ghost" data-open="'+esc(r.id)+'">进入操作</button></td></tr>').join("");
  return '<div class="grid2"><div class="panel"><h2>发布赛事</h2>'
    + '<label>赛事名称</label><input id="f-name" placeholder="如：2026秋季300公里预赛">'
    + '<label>距离（公里）</label><input id="f-dist" type="number" step="0.01" value="300">'
    + '<label>放飞地点</label><input id="f-point" placeholder="如：鹤壁放飞场">'
    + '<button class="primary" id="f-publish">发布赛事</button></div>'
    + '<div class="panel"><h2>赛事列表</h2><table><thead><tr><th>编号</th><th>名称</th><th>距离</th><th>放飞点</th><th>状态</th><th>放飞时间</th><th>入选</th><th>归巢</th><th></th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="9" class="muted">暂无赛事</td></tr>') + '</tbody></table></div></div>';
}

function viewDetail() {
  const r = currentRace();
  if (!r) return '<div class="panel muted">请先在「赛事」页发布或选择一场赛事。</div>';
  const lofts = [...new Set(pigeons.map(p => p.loft))].sort();
  const selectedLofts = r.entries.length ? [...new Set(r.entries.filter(e=>e.source==="loft").map(e=>e.loft))] : [];
  const entryRows = r.entries.map(e => {
    const p = pigeons.find(x=>x.ringNo===e.ringNo);
    const checked = r.checkins.some(c=>c.ringNo===e.ringNo);
    return '<tr><td>'+esc(e.ringNo)+'</td><td>'+esc(e.loft)+'</td><td>'+esc(p? p.owner:"")+'</td><td>'+esc(e.source==="loft"?"按棚圈定":"手工增补")+'</td><td>'+(checked?'<span class="tag released">已归巢</span>':'<span class="tag">待归巢</span>')+'</td><td>'+(r.status==="draft"?'<button class="danger" data-del-entry="'+esc(e.ringNo)+'">移出</button>':"—")+'</td></tr>';
  }).join("");
  return '<div class="panel"><div class="row" style="justify-content:space-between"><h2 style="margin:0">'+esc(r.id)+' · '+esc(r.name)+' '+raceTag(r)+'</h2><div class="muted">'+r.distance+' 公里 · 入选 '+r.entries.length+' 羽 · 归巢 '+r.checkins.length+' 羽</div></div></div>'
  + '<div class="grid2">'
  + '<div class="panel"><h2>按棚号圈定参赛名单</h2><div id="loft-chips">'
  + lofts.map(l=>'<span class="loft-chip '+((selectedLofts.includes(l))?"on":"")+'" data-loft="'+esc(l)+'">'+esc(l)+'</span>').join("")
  + '</div><p class="muted" style="font-size:12px">点选棚号后按「按棚圈定」，所选棚内正常状态赛鸽整体入选（异常鸽自动跳过并写审计）；手工增补保留。</p>'
  + '<button class="primary" id="btn-select">按棚圈定</button> '
  + (r.status==="draft"?'<button class="danger" id="btn-close" title="关闭后不再接收报到">关闭赛事</button>':"")
  + '<hr style="border:0;border-top:1px solid var(--line);margin:16px 0">'
  + '<label>手工增补赛鸽（环号）</label><div class="row"><input id="add-ring" placeholder="CHN-2026-008" style="flex:1"><button class="ghost" id="btn-add-entry">增补</button></div>'
  + (r.status==="draft"
      ? '<hr style="border:0;border-top:1px solid var(--line);margin:16px 0"><label>记录放飞时间</label><input id="release-at" type="datetime-local" value="'+nowLocalInput()+'"><button class="primary" id="btn-release">记录放飞</button>'
      : '<p class="muted">放飞时间：'+esc(new Date(r.releaseAt).toLocaleString("zh-CN"))+'</p>')
  + '</div>'
  + '<div class="panel"><h2>参赛名单（'+r.entries.length+'）</h2><table><thead><tr><th>环号</th><th>棚号</th><th>鸽主</th><th>来源</th><th>状态</th><th></th></tr></thead><tbody">'
  + (entryRows || '<tr><td colspan="6" class="muted">尚未圈定</td></tr>') + '</tbody></table></div>'
  + '</div>';
}

function viewCheckin() {
  const r = currentRace();
  if (!r) return '<div class="panel muted">请先选择赛事。</div>';
  const rows = r.checkins.slice().sort((a,b)=>a.arriveAt<b.arriveAt?-1:1).map(c => {
    const p = pigeons.find(x=>x.ringNo===c.ringNo);
    return '<tr><td>'+esc(c.ringNo)+'</td><td>'+esc(c.loft)+'</td><td>'+esc(p?p.owner:"")+'</td><td>'+esc(new Date(c.arriveAt).toLocaleString("zh-CN"))+'</td><td><button class="ghost" data-adj="'+esc(c.ringNo)+'">调整时间</button> <button class="danger" data-del-ck="'+esc(c.ringNo)+'">撤销报到</button></td></tr>';
  }).join("");
  return '<div class="grid2"><div class="panel"><h2>归巢报到</h2>'
    + '<label>赛事</label><input value="'+esc(r.id+" · "+r.name)+'" disabled>'
    + '<label>赛鸽环号</label><input id="ck-ring" placeholder="CHN-2026-002">'
    + '<label>申报棚号（可空；与登记棚不符将按跨棚成绩拦截）</label><input id="ck-loft" placeholder="留空表示按登记棚号报到">'
    + '<label>实际归巢时间</label><input id="ck-at" type="datetime-local" value="'+nowLocalInput()+'">'
    + '<button class="primary" id="btn-checkin">提交报到</button>'
    + '<hr style="border:0;border-top:1px solid var(--line);margin:16px 0">'
    + '<b>报到调整（纠偏）</b><div class="row" style="margin-top:8px"><input id="adj-ring" placeholder="环号" style="flex:1" readonly><input id="adj-at" type="datetime-local" style="flex:1"><button class="ghost" id="btn-adj-save">保存调整</button> <button class="ghost" id="btn-adj-cancel">取消</button></div>'
    + '<p class="muted" style="font-size:12px;margin-top:6px">在右侧「调整时间」载入记录后修改保存，系统重算全部名次并写调整审计。</p>'
    + '<p class="muted" style="font-size:12px">系统拦截：重复报到 · 未入选 · 跨棚成绩 · 状态异常 · 未放飞/时间早于放飞。拦截动作同样写审计。</p>'
    + '</div><div class="panel"><h2>已报到（'+r.checkins.length+'）</h2><table><thead><tr><th>环号</th><th>棚号</th><th>鸽主</th><th>归巢时间</th><th>操作</th></tr></thead><tbody">'
    + (rows || '<tr><td colspan="5" class="muted">暂无报到</td></tr>')+'</tbody></table></div></div>';
}

function viewRank() {
  const r = currentRace();
  if (!r) return '<div class="panel muted">请先选择赛事。</div>';
  const fmt = ms => { const m=Math.floor(ms/60000), s=Math.round((ms%60000)/1000); return m+"分"+s+"秒"; };
  const rows = r.checkins.map(c => {
    const p = pigeons.find(x=>x.ringNo===c.ringNo);
    const cls = c.rank<=3 ? "medal r"+c.rank : "";
    return '<tr><td class="medal '+cls+'">'+c.rank+'</td><td><b>'+esc(c.ringNo)+'</b></td><td>'+esc(c.loft)+'</td><td>'+esc(p?p.owner:"")+'</td><td>'+esc(new Date(c.arriveAt).toLocaleString("zh-CN"))+'</td><td>'+fmt(c.elapsedMs)+'</td><td><b>'+c.speed.toFixed(2)+'</b></td></tr>';
  }).join("");
  return '<div class="panel"><h2>'+esc(r.id)+' 成绩与排名（'+r.distance+'公里）</h2>'
    + '<p class="muted">分速 = 距离 × 1000 ÷ 实际飞行分钟数（米/分）；分速高者列前，同分速同名次。放飞：'+(r.releaseAt?esc(new Date(r.releaseAt).toLocaleString("zh-CN")):"未放飞")+'</p>'
    + '<table><thead><tr><th>名次</th><th>环号</th><th>棚号</th><th>鸽主</th><th>归巢时间</th><th>用时</th><th>分速(米/分)</th></tr></thead><tbody">'
    + (rows || '<tr><td colspan="7" class="muted">暂无归巢成绩</td></tr>')+'</tbody></table></div>';
}

function viewPigeons() {
  const rows = pigeons.map(p => '<tr><td><b>'+esc(p.ringNo)+'</b></td><td>'+esc(p.loft)+'</td><td>'+esc(p.owner)+'</td><td>'+esc(p.color)+'</td><td>'+statusTag(p)+'</td><td><select data-status="'+esc(p.ringNo)+'"><option>设为正常</option><option>设为异常</option><option>设为伤病</option><option>设为失格</option></select> <button class="ghost" data-set-status="'+esc(p.ringNo)+'">保存状态</button></td></tr>').join("");
  return '<div class="panel"><h2>已登记赛鸽名册（'+pigeons.length+'）</h2><p class="muted">档案在旧登记站维护；这里可标记状态，异常/伤病/失格鸽会被圈定跳过并在报到时拦截。</p>'
    + '<table><thead><tr><th>环号</th><th>棚号</th><th>鸽主</th><th>羽色</th><th>状态</th><th>调整状态</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}

let auditCache = [];
async function viewAudit() {
  auditCache = await api("/api/audit");
  const ACTION_CN = {race_publish:"发布赛事",entries_select:"按棚圈定",entries_add:"手工增补",entries_remove:"移出名单",race_release:"记录放飞",checkin:"归巢报到",checkin_rejected:"报到被拦截",rank_recompute:"重算排名",checkin_adjust:"调整报到",checkin_delete:"撤销报到",race_close:"关闭赛事",pigeon_status:"状态调整"};
  const rows = auditCache.map(e => '<tr><td>'+esc(new Date(e.at).toLocaleString("zh-CN"))+'</td><td>'+(e.result==="ok"?'<span class="tag released">成功</span>':e.result==="rejected"?'<span class="tag bad">拦截</span>':'<span class="tag bad">失败</span>')+'</td><td>'+esc(ACTION_CN[e.action]||e.action)+'</td><td><code>'+esc(e.target)+'</code></td><td style="white-space:normal;max-width:520px">'+esc(JSON.stringify(e.detail))+'</td></tr>').join("");
  return '<div class="panel"><h2>审计日志</h2><p class="muted">名单、报到、排名相关调整及所有拦截均落审计；写盘失败的事务整笔回滚，不留半条数据。</p>'
    + '<table><thead><tr><th>时间</th><th>结果</th><th>动作</th><th>对象</th><th>详情</th></tr></thead><tbody">'
    + (rows || '<tr><td colspan="5" class="muted">暂无审计</td></tr>')+'</tbody></table></div>';
}

async function render() {
  $("#nav").querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.tab===tab));
  const views = { races: viewRaces, detail: viewDetail, checkin: viewCheckin, rank: viewRank, pigeons: viewPigeons, audit: viewAudit };
  $("#main").innerHTML = await views[tab]();
  bind();
}

function bind() {
  if (tab === "races") {
    $("#f-publish").onclick = async () => {
      try { await api("/api/races", { body: { name: $("#f-name").value, distance: Number($("#f-dist").value), releasePoint: $("#f-point").value } }); toast("赛事已发布"); await refresh(); switchTab("detail"); }
      catch (e) { toast(e.message, false); }
    };
    $$("[data-open]").forEach(b => b.onclick = () => { currentRaceId = b.dataset.open; switchTab("detail"); });
  }
  if (tab === "detail") {
    const chosen = new Set($$(".loft-chip.on").map(c=>c.dataset.loft));
    $$(".loft-chip").forEach(c => c.onclick = () => { c.classList.toggle("on"); });
    $("#btn-select").onclick = async () => {
      const lofts = $$(".loft-chip.on").map(c=>c.dataset.loft);
      try { const race = await api("/api/races/"+currentRaceId+"/entries/select", { body: { lofts } }); toast("圈定完成，共 "+race.entries.length+" 羽入选"); await refresh(); }
      catch (e) { toast(e.message, false); }
    };
    $("#btn-add-entry").onclick = async () => {
      try { await api("/api/races/"+currentRaceId+"/entries", { body: { ringNo: $("#add-ring").value.trim() } }); toast("已增补"); await refresh(); }
      catch (e) { toast(e.message, false); }
    };
    $$("[data-del-entry]").forEach(b => b.onclick = async () => {
      try { await api("/api/races/"+currentRaceId+"/entries/"+encodeURIComponent(b.dataset.delEntry), { method:"DELETE" }); toast("已移出名单"); await refresh(); }
      catch (e) { toast(e.message, false); }
    });
    const rel = $("#btn-release");
    if (rel) rel.onclick = async () => {
      try { await api("/api/races/"+currentRaceId+"/release", { body: { releaseAt: new Date($("#release-at").value).toISOString() } }); toast("放飞时间已记录，赛事锁定名单"); await refresh(); }
      catch (e) { toast(e.message, false); }
    };
    const close = $("#btn-close");
    if (close) close.onclick = async () => {
      try { await api("/api/races/"+currentRaceId+"/close", { body:{} }); toast("赛事已关闭"); await refresh(); } catch(e){ toast(e.message,false); }
    };
  }
  if (tab === "checkin") {
    $("#btn-checkin").onclick = async () => {
      const payload = { ringNo: $("#ck-ring").value.trim(), arriveAt: new Date($("#ck-at").value).toISOString() };
      const loft = $("#ck-loft").value.trim(); if (loft) payload.loft = loft;
      try { await api("/api/races/"+currentRaceId+"/checkins", { body: payload }); toast("报到成功，名次已更新"); $("#ck-ring").value=""; $("#ck-loft").value=""; await refresh(); }
      catch (e) { toast(e.message, false); await refresh(); }
    };
    $$("[data-adj]").forEach(b => b.onclick = () => {
      const ring = b.dataset.adj;
      const c = currentRace().checkins.find(x => x.ringNo === ring);
      $("#adj-ring").value = ring;
      const d = new Date(c.arriveAt);
      $("#adj-at").value = nowLocalInput(d);
    });
    const adjSave = $("#btn-adj-save");
    adjSave.onclick = async () => {
      const ring = $("#adj-ring").value;
      if (!ring) return toast("请先在右侧点「调整时间」载入记录", false);
      try {
        await api("/api/races/"+currentRaceId+"/checkins/"+encodeURIComponent(ring), {
          method: "PUT",
          body: { arriveAt: new Date($("#adj-at").value).toISOString(), reason: "运营纠偏" },
        });
        toast("已调整并重算名次"); $("#adj-ring").value = "";
        await refresh();
      } catch (e) { toast(e.message, false); }
    };
    $("#btn-adj-cancel").onclick = () => { $("#adj-ring").value = ""; };
    $$("[data-del-ck]").forEach(b => b.onclick = async () => {
      try { await api("/api/races/"+currentRaceId+"/checkins/"+encodeURIComponent(b.dataset.delCk), { method:"DELETE", body:{ reason:"重复数据清理"} }); toast("已撤销报到"); await refresh(); }
      catch (e) { toast(e.message, false); }
    });
  }
  if (tab === "pigeons") {
    $$("[data-set-status]").forEach(b => b.onclick = async () => {
      const ring = b.dataset.setStatus;
      const map = {"设为正常":"正常","设为异常":"异常","设为伤病":"伤病","设为失格":"失格"};
      const status = map[$('select[data-status="'+ring+'"]').value];
      try { await api("/api/pigeons/"+encodeURIComponent(ring)+"/status", { body: { status, reason:"公棚运营标记" } }); toast("状态已更新并写审计"); await refresh(); }
      catch (e) { toast(e.message, false); }
    });
  }
}

function switchTab(t) { tab = t; render(); }
$("#nav").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) switchTab(b.dataset.tab); });
refresh();
</script>
</body>
</html>`;
}
