// 真实浏览器逐项验证：node tests/browser-e2e.mjs
// 自动启停一个隔离 DATA_DIR 的服务实例，用 Chromium 操作真实页面，逐项断言并截图。
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHOT = join(ROOT, "screenshots");
const PORT = 3025;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "pigeon-e2e-"));
cpSync(join(ROOT, "data", "pigeons.json"), join(dataDir, "pigeons.json"));

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) throw new Error("断言失败: " + name);
}

async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function startServer(port = PORT, dir = dataDir) {
  const proc = spawn(process.execPath, [join(ROOT, "server.js")], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: dir }, stdio: "ignore"
  });
  return proc;
}
async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + "/healthz")).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error("服务未就绪");
}

const server = startServer();
await waitHealthy();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addStyleTag({ content: "* { animation: none !important; }" }).catch(() => {});
const shot = n => page.screenshot({ path: join(SHOT, `${n}.png`), fullPage: true });
const toastText = () => page.locator("#toast").textContent();
// 先确保上一条 toast 消失，再点击，等新 toast 出现，避免读到旧消息
async function clickAndToast(selector, kind) {
  await page.evaluate(() => { document.querySelector("#toast").style.display = "none"; });
  await page.click(selector);
  await page.waitForFunction((k) => {
    const t = document.querySelector("#toast");
    return t.style.display === "block" && t.className.includes(k);
  }, kind, { timeout: 5000 });
  return toastText();
}
const waitToast = async (kind) => {
  await page.waitForFunction((k) => {
    const t = document.querySelector("#toast");
    return t.style.display === "block" && (k ? t.classList.contains(k) : true);
  }, kind, { timeout: 5000 });
  return toastText();
};

try {
  // ---------- 1. 发布赛事 ----------
  await page.goto(BASE + "/");
  await page.fill('[name="name"]', "2026 秋季 500 公里决赛");
  await page.fill('[name="distance"]', "500000");
  await page.fill('[name="lofts"]', "北岸A棚,南岸B棚");
  await shot("01-发布赛事表单");
  check("发布赛事", (await clickAndToast('[data-testid="publish-btn"]', "ok")).includes("已发布"));
  await page.waitForSelector(".race-item.sel");
  const raceTitle = await page.locator("#raceDetail h2").textContent();
  check("赛事详情打开", raceTitle.includes("2026 秋季 500 公里决赛"));
  await shot("02-赛事已发布");

  // ---------- 2. 圈定名单 ----------
  const rosterToast = await clickAndToast('[data-testid="select-roster-btn"]', "ok");
  check("圈定名单（入选7剔除伤病103）", rosterToast.includes("入选 7") && rosterToast.includes("剔除异常 1"), rosterToast);
  const entryRows = page.locator("#raceDetail table").first().locator("tbody tr, tr");
  const rowsCount = await page.locator("#raceDetail h3").first().textContent();
  const rosterText = await page.locator("#raceDetail").innerText();
  check("名单含 101 不含 103", rosterText.includes("CHN-2026-101") && !rosterText.split("参赛名单")[1].includes("CHN-2026-103"));
  await shot("03-圈定名单");

  // ---------- 3. 拦截：已发布赛事放飞后才能报到（先通过 API 造一只跨棚鸽）----------
  // 先把 104 在圈定后转去西二C棚，用于验证跨棚成绩拦截
  await api("/api/pigeons/CHN-2026-104/transfer", { method: "POST", body: JSON.stringify({ loft: "西二C棚" }) });
  // 把入选的 102 标记为伤病，验证状态异常拦截
  await api("/api/pigeons/CHN-2026-102/status", { method: "POST", body: JSON.stringify({ status: "injured" }) });

  // ---------- 4. 记录放飞 ----------
  await page.fill("#releaseTime", "2026-09-20T07:00");
  check("记录放飞", (await clickAndToast('[data-testid="release-btn"]', "ok")).includes("放飞时间已记录"));
  await page.waitForSelector("#arriveRing");
  await shot("04-已放飞待归巢");

  // ---------- 5. 归巢报到 + 排名 ----------
  const arrivals = [
    ["CHN-2026-201", "2026-09-20T13:10"],
    ["CHN-2026-101", "2026-09-20T13:40"],
    ["CHN-2026-202", "2026-09-20T13:05"]
  ];
  for (const [ring, t] of arrivals) {
    await page.fill("#arriveRing", ring);
    await page.fill("#arriveTime", t);
    const msg = await clickAndToast('[data-testid="arrival-btn"]', "ok");
    check(`报到 ${ring}`, msg.includes(ring), msg);
  }
  const rankText = await page.locator("#raceDetail").innerText();
  const rank1 = rankText.match(/实时排名[\s\S]*?1\s+?(CHN-\d{4}-\d+)/);
  check("分速排名：最快 202 第一", rank1 && rank1[1] === "CHN-2026-202", rank1?.[1]);
  check("分速计算正确（202: 1369.863 米/分）", rankText.includes("1369.863"));
  await shot("05-归巢排名");

  // ---------- 6. 四类拦截（页面操作，观察红色错误 toast）----------
  const blocked = async (ring, t, code, label) => {
    await page.fill("#arriveRing", ring);
    await page.fill("#arriveTime", t);
    const msg = await clickAndToast('[data-testid="arrival-btn"]', "err");
    check(label, msg.length > 0, msg);
    return msg;
  };
  await blocked("CHN-2026-201", "2026-09-20T14:00", "duplicate", "拦截：重复报到");
  await blocked("CHN-2026-301", "2026-09-20T13:20", "not_entered", "拦截：未入选赛鸽（西二C棚）");
  await blocked("CHN-2026-103", "2026-09-20T13:20", "not_entered", "拦截：伤病鸽未入选");
  const crossMsg = await blocked("CHN-2026-104", "2026-09-20T13:20", "cross_loft", "拦截：跨棚成绩");
  check("跨棚提示含双棚号", crossMsg.includes("北岸A棚") && crossMsg.includes("西二C棚"), crossMsg);
  const abnMsg = await blocked("CHN-2026-102", "2026-09-20T13:20", "abnormal", "拦截：入选鸽状态异常");
  check("状态异常提示", abnMsg.includes("伤病"), abnMsg);
  await blocked("CHN-9999-000", "2026-09-20T13:20", "not_found", "拦截：未登记足环号");
  await shot("06-拦截记录");

  // 被拦截的报到不得产生成绩
  const detail = await (await fetch(BASE + "/api/races/1")).json();
  check("拦截后仍只有 3 条归巢", detail.arrivals.length === 3, String(detail.arrivals.length));

  // ---------- 7. 成绩调整（作废）+ 名次重算 + 留痕 ----------
  page.once("dialog", d => d.accept("裁判组复核作废"));
  check("作废成绩后重算", (await clickAndToast('[data-void="CHN-2026-202"]', "ok")).includes("名次已重算"));
  const afterVoid = await (await fetch(BASE + "/api/races/1")).json();
  check("作废后 202 不出现在榜单", !afterVoid.arrivals.some(a => a.ring_no === "CHN-2026-202"));
  check("作废后 201 升为第 1", afterVoid.arrivals.find(a => a.ring_no === "CHN-2026-201").rank === 1);
  check("作废动作留痕", afterVoid.audit.some(a => a.action === "arrival.void" && a.detail.reason === "裁判组复核作废"));
  await shot("07-作废重算");

  // ---------- 8. 审计页 ----------
  await page.click('.tab[data-tab="Audit"]');
  await page.waitForFunction(() => document.querySelector("#tabAudit table")?.rows.length > 5);
  const auditText = await page.locator("#tabAudit").innerText();
  for (const kw of ["race.publish", "roster.select", "arrival.checkin", "拦截", "arrival.void", "rank.recompute", "duplicate_arrival", "cross_loft", "abnormal_status"]) {
    check(`审计含 ${kw}`, auditText.includes(kw));
  }
  await shot("08-审计日志");

  // ---------- 9. 关闭赛事后拦截 ----------
  await page.click('.tab[data-tab="Races"]');
  await page.click(".race-item");
  await clickAndToast('[data-act="close"]', "ok");
  const closed = await api("/api/races/1/arrivals", { method: "POST", body: JSON.stringify({ ringNo: "CHN-2026-101", arrivedAt: "2026-09-20T15:00" }) });
  check("关闭赛事后报到拦截", closed.status === 422 && closed.json.error === "race_closed", closed.json.error);

  // ---------- 10. 旧档案入口 ----------
  await page.goto(BASE + "/legacy");
  await page.waitForFunction(() => document.querySelectorAll("#cards .card").length >= 11);
  await page.fill("#search", "CHN-2026-001");
  await page.click("#searchBtn");
  await page.waitForFunction(() => document.querySelector("#detail")?.innerText.includes("血统档案"));
  const relText = await page.locator("#detail").innerText();
  check("旧档案：历史鸽血统可查", relText.includes("CHN-2022-188") && relText.includes("CHN-2023-512"));
  check("旧档案：历史成绩保留", relText.includes("120公里训放"));
  // 旧入口建档
  await page.fill('[name="ringNo"]', "CHN-2026-900");
  await page.fill('[name="owner"]', "测试鸽友");
  await page.fill('[name="color"]', "麒麟花");
  await page.fill('[name="loft"]', "南岸B棚");
  await page.click("#form button");
  await page.waitForFunction(() => [...document.querySelectorAll("#cards h3")].some(h => h.textContent === "CHN-2026-900"));
  check("旧档案入口：新建档案成功（新系统立即可见）", true);
  const newInOps = await (await fetch(BASE + "/api/pigeons")).json();
  check("新旧数据互通", newInOps.some(p => p.ring_no === "CHN-2026-900"));
  await shot("09-旧档案入口");

  // ---------- 11. 落盘失败恢复（故障注入 API + 页面核对）----------
  const r2 = await (await fetch(BASE + "/api/races", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "故障恢复测试赛", distance: 300000, lofts: ["南岸B棚"] })
  })).json();
  await api(`/api/races/${r2.id}/roster`, { method: "POST", body: JSON.stringify({ lofts: ["南岸B棚"] }) });
  await api(`/api/races/${r2.id}/release`, { method: "POST", body: JSON.stringify({ releaseAt: "2026-09-21T08:00" }) });
  const fault = await api(`/api/races/${r2.id}/arrivals`, {
    method: "POST",
    headers: { "x-fault": "arrival-insert" },
    body: JSON.stringify({ ringNo: "CHN-2026-201", arrivedAt: "2026-09-21T11:00" })
  });
  check("故障注入返回 500", fault.status === 500, String(fault.status));
  const mid = await (await fetch(BASE + `/api/races/${r2.id}`)).json();
  check("无半笔记录（报到+名次+审计整体回滚）", mid.arrivals.length === 0, `arrivals=${mid.arrivals.length}`);
  const recover = await api(`/api/races/${r2.id}/arrivals`, { method: "POST", body: JSON.stringify({ ringNo: "CHN-2026-201", arrivedAt: "2026-09-21T11:00" }) });
  check("故障后重试成功", recover.status === 201 && recover.json.rank === 1);
  await shot("10-故障恢复后");

  // ---------- 12. 重启持久化（真实重启进程）----------
  await browser.close();
  server.kill("SIGTERM");
  await sleep(500);
  check("无 -journal 残留", !existsSync(join(dataDir, "racing.db-journal")));
  const server2 = startServer();
  await waitHealthy();
  const browser2 = await chromium.launch();
  const page2 = await browser2.newPage({ viewport: { width: 1440, height: 1000 } });
  await page2.goto(BASE + "/");
  await page2.waitForSelector(".race-item");
  const raceCount = await page2.locator(".race-item").count();
  check("重启后赛事仍可查询", raceCount === 2, `赛事数=${raceCount}`);
  await page2.locator(".race-item", { hasText: "2026 秋季 500 公里决赛" }).click();
  await page2.waitForFunction(() => document.querySelector("#raceDetail")?.innerText.includes("实时排名"));
  const persisted = await page2.locator("#raceDetail").innerText();
  check("重启后名次保留（201 第 1）", persisted.includes("CHN-2026-201") && /实时排名[\s\S]*?1\s+?CHN-2026-201/.test(persisted));
  check("重启后拦截审计保留", persisted.includes("duplicate_arrival") && persisted.includes("cross_loft"));
  check("旧入口新建鸽重启后仍在", (await (await fetch(BASE + "/legacy/api/pigeons")).json()).some(p => p.ringNo === "CHN-2026-900"));
  await page2.screenshot({ path: join(SHOT, "11-重启后数据.png"), fullPage: true });
  await browser2.close();
  server2.kill("SIGTERM");

  console.log(`\n浏览器逐项验证完成：${results.filter(r => r.ok).length}/${results.length} 通过`);
} catch (e) {
  await page.screenshot({ path: join(SHOT, "ERROR.png"), fullPage: true }).catch(() => {});
  console.error(e);
  server.kill("SIGTERM");
  process.exit(1);
}
