import { DomainError } from "./store.js";

/**
 * 旧档案入口：把原「赛鸽血统环号登记站」整体挂载到 /legacy 下。
 * 页面内 /api/pigeons* 全部改写为 /legacy/api/pigeons*；
 * 写操作改走赛事系统的串行事务，与新系统共用 data/pigeons.json。
 */

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽血统环号登记站（旧档案）</title>
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
    .backbar { padding:8px 28px; background:#f3ead8; border-bottom:1px solid var(--line); font-size:13px; } .backbar a { color:var(--accent); font-weight:700; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <div class="backbar">旧档案入口（只读/原功能保留） · <a href="/">← 返回赛事运营系统</a></div>
  <header><div><h1>赛鸽血统环号登记站</h1><div class="meta">档案、血统、转让和归巢成绩</div></div><button id="reload">刷新</button></header>
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
        await api('/legacy/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to }) }); await load();
      });
      document.querySelectorAll("[data-score]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.score; const raw = document.querySelector('[data-race="'+ringNo+'"]').value.split("/");
        await api('/legacy/api/pigeons/'+encodeURIComponent(ringNo)+'/races', { method:'POST', body: JSON.stringify({ event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0) }) }); await load();
      });
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、转让和成绩。</p>'; return; }
      const p = data.pigeon;
      detail.innerHTML = '<h2>'+p.ringNo+' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>'+(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+p.owner+' · '+p.color+'</div><div class="small"><b>母鸽</b><br>'+(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div><div><b>子代</b> '+(data.children.map(c => c.ringNo).join("、") || "暂无")+'</div><div class="meta">转让：'+(p.transfers.map(t => t.from+"→"+t.to).join(" / ") || "暂无")+'</div><div class="meta">归巢：'+(p.races.map(r => r.event+" 第"+r.rank+"名").join(" / ") || "暂无")+'</div>';
    }
    async function load(){ pigeons = await api("/legacy/api/pigeons"); renderCards(); renderRelation(null); }
    document.querySelector("#searchBtn").onclick = async () => renderRelation(await api('/legacy/api/pigeons/'+encodeURIComponent(search.value)+'/relation'));
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/legacy/api/pigeons", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load();
    };
    load();
  </script>
</body>
</html>`;

export function isLegacyPath(pathname) {
  return pathname === "/legacy" || pathname === "/legacy/" || pathname.startsWith("/legacy/");
}

/** 处理 /legacy/* 请求。返回 true 表示已响应。 */
export async function handleLegacy(req, res, url, store, sendJson, body) {
  const pathname = url.pathname.replace(/^\/legacy/, "") || "/";

  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page);
    return true;
  }

  const db = await store.read();

  if (req.method === "GET" && pathname === "/api/pigeons") {
    sendJson(res, 200, db.pigeons.pigeons);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/pigeons") {
    const input = await body(req);
    await store.tx((d) => {
      if (d.pigeons.pigeons.some((item) => item.ringNo === input.ringNo)) {
        throw new DomainError("ring_exists", "足环号已存在");
      }
      d.pigeons.pigeons.unshift({
        ringNo: input.ringNo, owner: input.owner, fatherRing: input.fatherRing || "",
        motherRing: input.motherRing || "", color: input.color, loft: input.loft,
        status: "正常", vaccines: [], transfers: [], races: [],
      });
      return ["pigeons"];
    });
    sendJson(res, 201, { ok: true });
    return true;
  }

  const relationMatch = pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
  if (relationMatch && req.method === "GET") {
    const ringNo = decodeURIComponent(relationMatch[1]);
    const pigeon = db.pigeons.pigeons.find((item) => item.ringNo === ringNo);
    if (!pigeon) { sendJson(res, 404, { error: "pigeon_not_found" }); return true; }
    const father = db.pigeons.pigeons.find((item) => item.ringNo === pigeon.fatherRing) || null;
    const mother = db.pigeons.pigeons.find((item) => item.ringNo === pigeon.motherRing) || null;
    const children = db.pigeons.pigeons.filter((item) => item.fatherRing === ringNo || item.motherRing === ringNo);
    sendJson(res, 200, { pigeon, father, mother, children });
    return true;
  }

  const actionMatch = pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
  if (actionMatch && req.method === "POST") {
    const ringNo = decodeURIComponent(actionMatch[1]);
    const input = await body(req);
    await store.tx((d) => {
      const pigeon = d.pigeons.pigeons.find((item) => item.ringNo === ringNo);
      if (!pigeon) throw new DomainError("pigeon_not_found", "赛鸽未登记");
      const today = new Date().toISOString().slice(0, 10);
      if (actionMatch[2] === "transfers") {
        if (!input.to) throw new DomainError("to_required", "新归属人不能为空");
        pigeon.transfers.push({ date: input.date || today, from: pigeon.owner, to: input.to });
        pigeon.owner = input.to;
      }
      if (actionMatch[2] === "races") {
        pigeon.races.push({ date: input.date || today, event: input.event, distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0) });
      }
      if (actionMatch[2] === "vaccines") pigeon.vaccines.push({ date: input.date || today, name: input.name });
      return ["pigeons"];
    });
    const after = await store.read();
    sendJson(res, 200, after.pigeons.pigeons.find((item) => item.ringNo === ringNo));
    return true;
  }

  return false;
}
