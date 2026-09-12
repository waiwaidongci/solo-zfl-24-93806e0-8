import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import {
  HttpError,
  adjustRoster,
  checkin,
  closeRace,
  createRace,
  getRace,
  listAudit,
  listLofts,
  listRaces,
  publishRace,
  releaseRace,
  voidCheckin
} from "./raceService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultDbPath = join(__dirname, "data", "pigeons.json");
const port = Number(process.env.PORT || 3024);

const seed = {
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-04-01", name: "新城疫" }], transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
  ],
  races: [],
  audit: [],
  meta: { raceSeq: 0, auditSeq: 0 }
};

/** 老档案升级:补齐赛事与审计字段,原有鸽只数据不动。 */
function migrate(db) {
  db.pigeons ??= [];
  db.races ??= [];
  db.audit ??= [];
  db.meta ??= { raceSeq: 0, auditSeq: 0 };
  db.meta.raceSeq ??= 0;
  db.meta.auditSeq ??= 0;
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function relation(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  return { pigeon, father, mother, children };
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽血统环号登记站</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; } .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .section { margin-top:14px; } .relation { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; } .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; }
    .navlink { background:#fff; color:var(--accent); border:1px solid var(--accent); text-decoration:none; padding:10px 13px; border-radius:6px; font-weight:700; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽血统环号登记站</h1><div class="meta">档案、血统、转让和归巢成绩</div></div><div style="display:flex;gap:10px"><a class="navlink" href="/races">赛事运营</a><button id="reload">刷新</button></div></header>
  <main>
    <form id="form">
      <h2>创建鸽只档案</h2>
      <label>足环号</label><input name="ringNo" required>
      <label>鸽主</label><input name="owner" required>
      <label>父鸽足环号</label><input name="fatherRing">
      <label>母鸽足环号</label><input name="motherRing">
      <label>羽色</label><input name="color" required>
      <label>出生棚号</label><input name="loft" required>
      <button>保存档案</button>
    </form>
    <section>
      <div class="toolbar"><input id="search" placeholder="输入足环号查询血统"><button id="searchBtn">查询</button></div>
      <div class="panel" id="detail"></div>
      <div class="section grid" id="cards"></div>
    </section>
  </main>
  <script>
    const form = document.querySelector("#form");
    const cards = document.querySelector("#cards");
    const detail = document.querySelector("#detail");
    const search = document.querySelector("#search");
    let pigeons = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function renderCards() {
      cards.innerHTML = pigeons.map(p => '<article class="card"><h3>'+p.ringNo+'</h3><span class="pill">'+p.owner+'</span><div class="meta">'+p.color+' · '+p.loft+'</div><div>父：'+(p.fatherRing || "未登记")+'</div><div>母：'+(p.motherRing || "未登记")+'</div><label>录入转让</label><input data-to="'+p.ringNo+'" placeholder="新归属人"><button data-transfer="'+p.ringNo+'">保存转让</button><label>归巢成绩</label><input data-race="'+p.ringNo+'" placeholder="赛事/距离/名次，如200公里/200/6"><button data-score="'+p.ringNo+'">保存成绩</button></article>').join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+ringNo+'"]').value;
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to }) }); await load();
      });
      document.querySelectorAll("[data-score]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.score; const raw = document.querySelector('[data-race="'+ringNo+'"]').value.split("/");
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/races', { method:'POST', body: JSON.stringify({ event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0) }) }); await load();
      });
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、转让和成绩。</p>'; return; }
      const p = data.pigeon;
      detail.innerHTML = '<h2>'+p.ringNo+' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>'+(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+p.owner+' · '+p.color+'</div><div class="small"><b>母鸽</b><br>'+(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div><div><b>子代</b> '+(data.children.map(c => c.ringNo).join("、") || "暂无")+'</div><div class="meta">转让：'+(p.transfers.map(t => t.from+"→"+t.to).join(" / ") || "暂无")+'</div><div class="meta">归巢：'+(p.races.map(r => r.event+" 第"+r.rank+"名").join(" / ") || "暂无")+'</div>';
    }
    async function load(){ pigeons = await api("/api/pigeons"); renderCards(); renderRelation(null); }
    document.querySelector("#searchBtn").onclick = async () => renderRelation(await api('/api/pigeons/'+encodeURIComponent(search.value)+'/relation'));
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/pigeons", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load();
    };
    load();
  </script>
</body>
</html>`;

const racesPage = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛事运营 · 赛鸽公棚</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --green:#2f7d4f; --amber:#9a6b1f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:14px 0 8px; font-size:15px; }
    main { display:grid; grid-template-columns:360px 1fr; gap:22px; padding:22px 28px; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; }
    input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.danger { background:var(--red); } button.ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); }
    .navlink { background:#fff; color:var(--accent); border:1px solid var(--accent); text-decoration:none; padding:10px 13px; border-radius:6px; font-weight:700; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border-radius:999px; padding:3px 10px; font-size:12px; font-weight:700; }
    .st-draft { background:#e8edf2; color:#43525f; } .st-published { background:#fdf3e0; color:var(--amber); }
    .st-released { background:#e3f3e9; color:var(--green); } .st-closed { background:#f6e4e2; color:var(--red); }
    .race-item { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:8px; cursor:pointer; display:flex; justify-content:space-between; gap:8px; align-items:center; }
    .race-item.active { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
    table { width:100%; border-collapse:collapse; font-size:14px; } th,td { border-bottom:1px solid var(--line); padding:8px 6px; text-align:left; } th { color:var(--muted); font-size:12px; }
    .error { background:#f9e9e7; border:1px solid var(--red); color:var(--red); border-radius:8px; padding:10px 12px; margin:10px 0; font-weight:700; display:none; }
    .ok { background:#e3f3e9; border:1px solid var(--green); color:var(--green); border-radius:8px; padding:10px 12px; margin:10px 0; display:none; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:10px; } .actions { display:flex; gap:8px; flex-wrap:wrap; margin:12px 0; }
    .audit-item { border-bottom:1px dashed var(--line); padding:6px 0; font-size:13px; } .audit-item .meta { font-size:12px; }
    .loft-check { display:flex; gap:6px; align-items:center; margin:4px 0; } .loft-check input { width:auto; }
    .void-row { color:var(--muted); text-decoration:line-through; }
    @media (max-width:900px){ main{grid-template-columns:1fr;padding:16px;} header{display:block;padding:18px 16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>赛事运营系统</h1><div class="meta">发布赛事 · 圈定名单 · 放飞报到 · 分速排名 · 审计留痕</div></div>
    <a class="navlink" href="/">旧档案入口</a>
  </header>
  <main>
    <section>
      <div class="panel">
        <h2>发布赛事</h2>
        <label>赛事名称</label><input id="raceName" placeholder="如:300公里资格赛">
        <label>空距(公里)</label><input id="raceDistance" type="number" min="1" step="0.1" placeholder="如:300">
        <label>圈定棚号</label><div id="loftChecks"></div>
        <div class="actions"><button id="btnCreate">创建赛事并圈定名单</button></div>
      </div>
      <div class="panel">
        <h2>赛事列表</h2>
        <div id="raceList"></div>
      </div>
    </section>
    <section>
      <div class="error" id="errorBox"></div>
      <div class="ok" id="okBox"></div>
      <div class="panel" id="raceDetail"><h2>赛事详情</h2><p class="meta">请从左侧选择一场赛事,或先创建新赛事。</p></div>
      <div class="panel">
        <h2>审计留痕</h2>
        <div id="auditLog" class="meta">暂无审计记录。</div>
      </div>
    </section>
  </main>
  <script>
    const $ = sel => document.querySelector(sel);
    let races = [], selectedId = null, lofts = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.message || data.error || "请求失败"); err.code = data.error; throw err; }
      return data;
    }
    function showError(msg){ const box = $("#errorBox"); box.textContent = "已拦截:" + msg; box.style.display = "block"; $("#okBox").style.display = "none"; }
    function showOk(msg){ const box = $("#okBox"); box.textContent = msg; box.style.display = "block"; $("#errorBox").style.display = "none"; }
    function toIso(local){ return local ? new Date(local).toISOString() : ""; }
    const ST = { draft:"草稿", published:"已发布", released:"已放飞", closed:"已封存" };

    function renderLoftChecks(){
      $("#loftChecks").innerHTML = lofts.map(l => '<label class="loft-check"><input type="checkbox" value="'+l+'"> '+l+'</label>').join("") || '<span class="meta">暂无登记棚号</span>';
    }
    function renderRaceList(){
      $("#raceList").innerHTML = races.map(r => '<div class="race-item'+(r.id===selectedId?" active":"")+'" data-race="'+r.id+'"><div><b>'+r.name+'</b><div class="meta">'+r.id+' · '+r.distanceKm+'公里 · '+r.roster.length+'羽</div></div><span class="pill st-'+r.status+'">'+ST[r.status]+'</span></div>').join("") || '<span class="meta">暂无赛事</span>';
      document.querySelectorAll("[data-race]").forEach(el => el.onclick = () => { selectedId = el.dataset.race; renderAll(); });
    }
    function renderDetail(){
      const box = $("#raceDetail");
      const r = races.find(x => x.id === selectedId);
      if (!r) { box.innerHTML = '<h2>赛事详情</h2><p class="meta">请从左侧选择一场赛事,或先创建新赛事。</p>'; return; }
      const board = r.checkins.filter(c => c.status === "valid").sort((a,b) => a.rank - b.rank);
      const voids = r.checkins.filter(c => c.status === "void");
      box.innerHTML =
        '<h2>'+r.name+' <span class="pill st-'+r.status+'">'+ST[r.status]+'</span></h2>'+
        '<div class="meta">'+r.id+' · 空距 '+r.distanceKm+' 公里 · 棚号 '+r.lofts.join("、")+' · 放飞时间 '+(r.releaseTime || "未记录")+'</div>'+
        '<h3>参赛名单('+r.roster.length+'羽)</h3><div class="meta" id="rosterView">'+r.roster.join("、")+'</div>'+
        (r.status === "draft" ?
          '<div class="row"><div><label>加入足环号</label><input id="rosterAdd" placeholder="CHN-2026-002"></div><div><label>移除足环号</label><input id="rosterRemove" placeholder="CHN-2026-001"></div></div>'+
          '<div class="actions"><button class="ghost" id="btnRosterApply">保存名单调整</button><button id="btnPublish">发布赛事(锁定名单)</button></div>' : "")+
        (r.status === "published" ?
          '<h3>记录放飞时间</h3><label>放飞时间</label><input id="releaseTime" type="datetime-local"><div class="actions"><button id="btnRelease">确认放飞</button></div>' : "")+
        (r.status === "released" ?
          '<h3>归巢报到</h3><div class="row"><div><label>足环号</label><input id="ciRing" placeholder="CHN-2026-001"></div><div><label>报到棚号</label><input id="ciLoft" placeholder="北岸A棚"></div></div>'+
          '<label>归巢时间</label><input id="ciArrival" type="datetime-local" step="1"><div class="actions"><button id="btnCheckin">登记报到</button><button class="danger" id="btnClose">封存赛事(名次定稿)</button></div>' : "")+
        '<h3>成绩榜</h3>'+
        (board.length || voids.length ?
          '<table id="board"><thead><tr><th>名次</th><th>足环号</th><th>棚号</th><th>归巢时间</th><th>用时(分)</th><th>分速(米/分)</th><th>操作</th></tr></thead><tbody>'+
          board.map(c => '<tr><td>'+c.rank+'</td><td>'+c.ringNo+'</td><td>'+c.loft+'</td><td>'+c.arrivalTime+'</td><td>'+c.elapsedMin+'</td><td>'+c.speed+'</td><td>'+(r.status==="released"?'<button class="ghost" data-void="'+c.ringNo+'">作废</button>':"")+'</td></tr>').join("")+
          voids.map(c => '<tr class="void-row"><td>—</td><td>'+c.ringNo+'</td><td>'+c.loft+'</td><td>'+c.arrivalTime+'</td><td>'+c.elapsedMin+'</td><td>'+c.speed+'</td><td>已作废</td></tr>').join("")+
          '</tbody></table>' : '<p class="meta">暂无报到记录。</p>');
      if (r.status === "draft") {
        $("#btnRosterApply").onclick = async () => {
          try {
            const add = $("#rosterAdd").value.trim(), remove = $("#rosterRemove").value.trim();
            await api("/api/races/"+r.id+"/roster", { method:"POST", body: JSON.stringify({ add: add?[add]:[], remove: remove?[remove]:[] }) });
            showOk("名单已调整"); await reload();
          } catch (e) { showError(e.message); }
        };
        $("#btnPublish").onclick = async () => { try { await api("/api/races/"+r.id+"/publish", { method:"POST" }); showOk("赛事已发布,名单锁定"); await reload(); } catch (e) { showError(e.message); } };
      }
      if (r.status === "published") {
        $("#btnRelease").onclick = async () => {
          try { await api("/api/races/"+r.id+"/release", { method:"POST", body: JSON.stringify({ releaseTime: toIso($("#releaseTime").value) }) }); showOk("已记录放飞时间,开始接受报到"); await reload(); }
          catch (e) { showError(e.message); }
        };
      }
      if (r.status === "released") {
        $("#btnCheckin").onclick = async () => {
          try {
            const res = await api("/api/races/"+r.id+"/checkins", { method:"POST", body: JSON.stringify({ ringNo: $("#ciRing").value.trim(), loft: $("#ciLoft").value.trim(), arrivalTime: toIso($("#ciArrival").value) }) });
            showOk("报到成功:"+res.entry.ringNo+" 分速 "+res.entry.speed+",暂列第 "+res.entry.rank+" 名"); await reload();
          } catch (e) { showError(e.message); }
        };
        $("#btnClose").onclick = async () => { try { await api("/api/races/"+r.id+"/close", { method:"POST" }); showOk("赛事已封存,名次定稿"); await reload(); } catch (e) { showError(e.message); } };
        document.querySelectorAll("[data-void]").forEach(btn => btn.onclick = async () => {
          const reason = prompt("作废原因", "足环扫描异常");
          if (reason === null) return;
          try { await api("/api/races/"+r.id+"/checkins/"+encodeURIComponent(btn.dataset.void)+"/void", { method:"POST", body: JSON.stringify({ reason }) }); showOk("已作废并重排名次"); await reload(); }
          catch (e) { showError(e.message); }
        });
      }
    }
    async function renderAudit(){
      const data = await api("/api/audit"+(selectedId ? "?raceId="+selectedId : ""));
      $("#auditLog").innerHTML = data.slice().reverse().map(a => '<div class="audit-item"><b>#'+a.seq+" "+a.action+'</b> <span class="meta">'+a.ts+" · "+a.actor+'</span><br>'+a.detail+'</div>').join("") || "暂无审计记录。";
    }
    async function reload(){ races = await api("/api/races"); renderRaceList(); renderDetail(); await renderAudit(); }
    async function renderAll(){ renderRaceList(); renderDetail(); await renderAudit(); }
    $("#btnCreate").onclick = async () => {
      try {
        const loftsPicked = [...document.querySelectorAll("#loftChecks input:checked")].map(el => el.value);
        const race = await api("/api/races", { method:"POST", body: JSON.stringify({ name: $("#raceName").value, distanceKm: Number($("#raceDistance").value), lofts: loftsPicked }) });
        selectedId = race.id; showOk("赛事已创建,按棚号圈定 "+race.roster.length+" 羽"); await reload();
      } catch (e) { showError(e.message); }
    };
    (async () => { lofts = await api("/api/lofts"); renderLoftChecks(); await reload(); })();
  </script>
</body>
</html>`;

export function createApp({ dbPath = defaultDbPath, persistHook = null } = {}) {
  const store = new Store(dbPath, { seed, migrate });
  store.persistHook = persistHook;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const db = store.data;

      // ---------- 旧档案入口(保持原有行为) ----------
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page);
      }
      if (req.method === "GET" && url.pathname === "/api/pigeons") return sendJson(res, 200, db.pigeons);
      if (req.method === "POST" && url.pathname === "/api/pigeons") {
        const input = await body(req);
        const created = await store.mutate(async state => {
          if (state.pigeons.some(item => item.ringNo === input.ringNo)) throw new HttpError(409, "ring_exists", "足环号已存在");
          const pigeon = { ...input, vaccines: [], transfers: [], races: [] };
          state.pigeons.unshift(pigeon);
          return pigeon;
        });
        return sendJson(res, 201, created);
      }
      const relationMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
      if (relationMatch && req.method === "GET") {
        const data = relation(db, decodeURIComponent(relationMatch[1]));
        return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
      }
      const actionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
      if (actionMatch && req.method === "POST") {
        const ringNo = decodeURIComponent(actionMatch[1]);
        const kind = actionMatch[2];
        const input = await body(req);
        const updated = await store.mutate(async state => {
          const pigeon = state.pigeons.find(item => item.ringNo === ringNo);
          if (!pigeon) throw new HttpError(404, "pigeon_not_found", "鸽只不存在");
          if (kind === "transfers") {
            const transfer = { date: input.date || new Date().toISOString().slice(0, 10), from: pigeon.owner, to: input.to };
            pigeon.owner = input.to;
            pigeon.transfers.push(transfer);
          }
          if (kind === "races") pigeon.races.push({ date: input.date || new Date().toISOString().slice(0, 10), event: input.event, distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0) });
          if (kind === "vaccines") pigeon.vaccines.push({ date: input.date || new Date().toISOString().slice(0, 10), name: input.name });
          return pigeon;
        });
        return sendJson(res, 200, updated);
      }

      // ---------- 赛事运营 ----------
      if (req.method === "GET" && url.pathname === "/races") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(racesPage);
      }
      if (req.method === "GET" && url.pathname === "/api/lofts") return sendJson(res, 200, listLofts(db));
      if (req.method === "GET" && url.pathname === "/api/races") return sendJson(res, 200, listRaces(db));
      if (req.method === "POST" && url.pathname === "/api/races") {
        const input = await body(req);
        const race = await store.mutate(async state => createRace(state, input));
        return sendJson(res, 201, race);
      }
      if (req.method === "GET" && url.pathname === "/api/audit") {
        return sendJson(res, 200, listAudit(db, { raceId: url.searchParams.get("raceId") || undefined }));
      }
      const raceMatch = url.pathname.match(/^\/api\/races\/([^/]+)(?:\/(roster|publish|release|checkins|close))?(?:\/([^/]+)\/void)?$/);
      if (raceMatch) {
        const raceId = raceMatch[1];
        const sub = raceMatch[2];
        if (req.method === "GET" && !sub) return sendJson(res, 200, getRace(db, raceId));
        if (req.method === "POST" && sub === "roster") {
          const input = await body(req);
          const race = await store.mutate(async state => adjustRoster(state, raceId, input));
          return sendJson(res, 200, race);
        }
        if (req.method === "POST" && sub === "publish") {
          const race = await store.mutate(async state => publishRace(state, raceId));
          return sendJson(res, 200, race);
        }
        if (req.method === "POST" && sub === "release") {
          const input = await body(req);
          const race = await store.mutate(async state => releaseRace(state, raceId, input));
          return sendJson(res, 200, race);
        }
        if (req.method === "POST" && sub === "checkins" && !raceMatch[3]) {
          const input = await body(req);
          const result = await store.mutate(async state => checkin(state, raceId, input));
          return sendJson(res, 201, result);
        }
        if (req.method === "POST" && sub === "checkins" && raceMatch[3]) {
          const input = await body(req);
          const race = await store.mutate(async state => voidCheckin(state, raceId, decodeURIComponent(raceMatch[3]), input));
          return sendJson(res, 200, race);
        }
        if (req.method === "POST" && sub === "close") {
          const race = await store.mutate(async state => closeRace(state, raceId));
          return sendJson(res, 200, race);
        }
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.code, message: error.message });
      sendJson(res, 500, { error: "internal_error", message: error.message });
    }
  });

  return { server, store, ready: store.load() };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { server, ready } = createApp();
  ready.then(() => {
    server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
  });
}
