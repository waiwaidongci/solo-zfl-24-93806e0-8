// 真实浏览器 E2E：发布赛事 → 圈名单 → 放飞 → 归巢排名 → 四类拦截 → 调整/审计 → 旧档案 → 失败恢复 → 重启
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, cp, mkdir, readdir, rm } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const shotDir = join(root, "test", "e2e", "screenshots");
await mkdir(shotDir, { recursive: true });
for (const f of await readdir(shotDir)) await rm(join(shotDir, f));

const dataDir = await mkdtemp(join(tmpdir(), "pigeon-e2e-"));
await cp(join(root, "data", "pigeons.json"), join(dataDir, "pigeons.json"));
const PORT = 41000 + Math.floor(Math.random() * 9000);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}

// 无 root 环境下通过用户目录解包的 chromium 系统库（见 README「浏览器依赖」）
function localChromiumLibs() {
  const localRoot = join(process.env.HOME || "/home/node", ".apt-local", "root");
  if (!existsSync(localRoot)) return "";
  const dirs = new Set();
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith(".so") || ent.name.includes(".so.")) dirs.add(dir);
    }
  };
  walk(localRoot);
  return [...dirs].join(":");
}

function startServer() {
  const child = spawn(process.execPath, [join(root, "server.js")], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), FAILPOINT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));
  return child;
}
async function waitUp() {
  const deadline = Date.now() + 8000;
  for (;;) {
    try { if ((await fetch(BASE + "/api/pigeons")).ok) return; } catch {}
    if (Date.now() > deadline) throw new Error("server not up");
    await new Promise((r) => setTimeout(r, 100));
  }
}
const stop = (child) => new Promise((res) => {
  if (!child || child.killed) return res();
  child.on("exit", res);
  child.kill("SIGTERM");
});

let server = startServer();
await waitUp();
const launchOpts = {
  headless: true,
  env: { ...process.env, LD_LIBRARY_PATH: `${localChromiumLibs()}:${process.env.LD_LIBRARY_PATH || ""}` },
};
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

/** 清空旧提示，执行 action，等待新提示出现 */
async function toastAfter(action) {
  await page.evaluate(() => {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
  });
  await action();
  const t = await page.waitForSelector(".toast.show", { timeout: 5000 });
  return { text: (await t.textContent()).trim(), ok: (await t.getAttribute("class")).includes("ok") };
}

let raceId = null;
try {
  // 1) 首页 / 发布赛事
  await page.goto(BASE + "/");
  await page.waitForSelector("#f-publish");
  await page.screenshot({ path: join(shotDir, "01-home.png"), fullPage: true });
  await page.fill("#f-name", "2026秋季300公里预赛");
  await page.fill("#f-dist", "300");
  await page.fill("#f-point", "鹤壁放飞场");
  let toast = await toastAfter(() => page.click("#f-publish"));
  check("发布赛事", toast.ok && toast.text.includes("赛事已发布"), toast.text);
  await page.waitForSelector("#btn-select");
  raceId = await page.evaluate(() => currentRaceId);
  await page.screenshot({ path: join(shotDir, "01b-published.png"), fullPage: true });

  // 2) 按棚号圈定：北岸A棚(5羽) + 东风B棚(3羽) = 8羽
  await page.click('[data-loft="北岸A棚"]');
  await page.click('[data-loft="东风B棚"]');
  toast = await toastAfter(() => page.click("#btn-select"));
  check("按棚圈定两棚共8羽", toast.ok && /共 8 羽入选/.test(toast.text), toast.text);
  await page.waitForFunction(() => document.querySelectorAll("#main tbody tr").length === 8);
  await page.screenshot({ path: join(shotDir, "02-entries.png"), fullPage: true });

  // 3) 记录放飞时间（显式 +08:00，避免浏览器时区差异）
  await page.fill("#release-at", "2026-09-12T08:00");
  toast = await toastAfter(() => page.click("#btn-release"));
  check("记录放飞", toast.ok && toast.text.includes("放飞时间已记录"), toast.text);
  await page.screenshot({ path: join(shotDir, "03-released.png"), fullPage: true });

  // 4) 归巢报到：11:30 / 11:45 / 12:00
  await page.click('button[data-tab="checkin"]');
  await page.waitForSelector("#btn-checkin");
  const arrivals = [
    ["CHN-2026-002", "2026-09-12T11:30"],
    ["CHN-2026-003", "2026-09-12T11:45"],
    ["CHN-2026-001", "2026-09-12T12:00"],
  ];
  for (const [ring, at] of arrivals) {
    await page.fill("#ck-ring", ring);
    await page.fill("#ck-loft", "");
    await page.fill("#ck-at", at);
    toast = await toastAfter(() => page.click("#btn-checkin"));
    check(`报到 ${ring}`, toast.ok, toast.text);
  }
  await page.screenshot({ path: join(shotDir, "04-checkins.png"), fullPage: true });

  // 5) 四类拦截
  async function rejectedCheckin(fields, expect, label) {
    await page.fill("#ck-ring", fields.ring || "");
    await page.fill("#ck-loft", fields.loft || "");
    await page.fill("#ck-at", fields.at);
    const t = await toastAfter(() => page.click("#btn-checkin"));
    check(label, !t.ok && t.text.includes(expect), t.text);
  }
  await rejectedCheckin({ ring: "CHN-2026-002", at: "2026-09-12T12:05" }, "重复报到", "重复报到拦截");
  await rejectedCheckin({ ring: "CHN-2026-008", at: "2026-09-12T11:40" }, "未入选", "未入选拦截");
  await rejectedCheckin({ ring: "CHN-2026-004", loft: "东风B棚", at: "2026-09-12T11:41" }, "跨棚", "跨棚成绩拦截");

  // 状态异常：名册页把 011 置为失格，再报到
  await page.click('button[data-tab="pigeons"]');
  await page.waitForSelector('select[data-status="CHN-2026-011"]');
  await page.selectOption('select[data-status="CHN-2026-011"]', { label: "设为失格" });
  toast = await toastAfter(() => page.click('button[data-set-status="CHN-2026-011"]'));
  check("标记失格", toast.ok, toast.text);
  await page.click('button[data-tab="checkin"]');
  await page.waitForSelector("#ck-ring");
  await rejectedCheckin({ ring: "CHN-2026-011", at: "2026-09-12T11:50" }, "状态异常", "状态异常拦截");

  // 6) 排名
  await page.click('button[data-tab="rank"]');
  await page.waitForFunction(() => document.querySelectorAll("#main tbody tr").length === 3);
  const rows = await page.$$eval("#main tbody tr", (trs) =>
    trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())));
  check("名次顺序 002>003>001",
    rows[0][1] === "CHN-2026-002" && rows[1][1] === "CHN-2026-003" && rows[2][1] === "CHN-2026-001",
    rows.map((r) => r[1]).join(">"));
  check("分速 002=1428.57", rows[0][6] === "1428.57", rows[0][6]);
  check("分速 001=1250.00", rows[2][6] === "1250.00", rows[2][6]);
  await page.screenshot({ path: join(shotDir, "05-rank.png"), fullPage: true });

  // 7) 调整报到（001 改到 11:20 → 升为第1，分速 300000/200 = 1500）
  await page.click('button[data-tab="checkin"]');
  await page.click('[data-adj="CHN-2026-001"]');
  await page.fill("#adj-at", "2026-09-12T11:20");
  toast = await toastAfter(() => page.click("#btn-adj-save"));
  check("调整归巢时间", toast.ok && toast.text.includes("已调整并重算名次"), toast.text);
  await page.click('button[data-tab="rank"]');
  const top = await page.$eval("#main tbody tr:first-child td:nth-child(2)", (el) => el.textContent.trim());
  const topSpeed = await page.$eval("#main tbody tr:first-child td:nth-child(7)", (el) => el.textContent.trim());
  check("调整后 001 升至第1", top === "CHN-2026-001", top);
  check("调整后分速重算为1500.00", topSpeed === "1500.00", topSpeed);
  await page.screenshot({ path: join(shotDir, "06-rank-after-adjust.png"), fullPage: true });

  // 8) 审计
  await page.click('button[data-tab="audit"]');
  await page.waitForFunction(() => document.querySelectorAll("#main tbody tr").length > 5);
  const auditText = await page.$eval("#main tbody", (el) => el.textContent);
  check("审计含发布/圈定/放飞", auditText.includes("发布赛事") && auditText.includes("按棚圈定") && auditText.includes("记录放飞"));
  check("审计含归巢报到", auditText.includes("归巢报到"));
  check("审计含拦截记录", auditText.includes("报到被拦截"));
  check("审计含调整", auditText.includes("调整报到"));
  const rejectedCount = await page.$$eval("#main tbody tr", (trs) =>
    trs.filter((tr) => tr.textContent.includes("报到被拦截")).length);
  check("拦截审计 ≥4 条（重复/未入选/跨棚/异常）", rejectedCount >= 4, String(rejectedCount));
  await page.screenshot({ path: join(shotDir, "07-audit.png"), fullPage: true });

  // 9) 旧档案入口
  await page.goto(BASE + "/legacy/");
  await page.waitForFunction(() => document.title.includes("旧档案"));
  const legacyHasCards = await page.$$eval("#cards .card", (els) => els.length);
  check("旧档案入口可访问且名册存在", legacyHasCards >= 13, String(legacyHasCards));
  await page.screenshot({ path: join(shotDir, "08-legacy.png"), fullPage: true });

  // 10) 写盘失败不留半条
  const beforeRace = await (await fetch(`${BASE}/api/races/${raceId}`)).json();
  const countBefore = beforeRace.checkins.length;
  await page.evaluate(() => fetch("/api/test/fail-next-write", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 1 }),
  }));
  const failRes = await page.evaluate(async (id) => {
    const r = await fetch(`/api/races/${id}/checkins`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ringNo: "CHN-2026-004", arriveAt: "2026-09-12T16:10:00+08:00" }),
    });
    return { status: r.status, body: await r.json() };
  }, raceId);
  check("故障注入报到返回500", failRes.status === 500, `${failRes.status} ${JSON.stringify(failRes.body)}`);
  const afterRace = await (await fetch(`${BASE}/api/races/${raceId}`)).json();
  check("失败后无半条报到", afterRace.checkins.length === countBefore, `${countBefore} -> ${afterRace.checkins.length}`);
  const tmpFiles = (await readdir(dataDir)).filter((f) => f.includes(".tmp-"));
  check("无遗留临时文件", tmpFiles.length === 0, JSON.stringify(tmpFiles));
  const recoverRes = await page.evaluate(async (id) => {
    const r = await fetch(`/api/races/${id}/checkins`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ringNo: "CHN-2026-004", arriveAt: "2026-09-12T16:10:00+08:00" }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, raceId);
  check("故障耗尽后再次报到成功", recoverRes.status === 201, `${recoverRes.status} ${JSON.stringify(recoverRes.body)}`);

  // 11) 重启持久化
  await browser.close();
  await stop(server);
  server = startServer();
  await waitUp();
  const browser2 = await chromium.launch(launchOpts);
  const page2 = await browser2.newPage({ viewport: { width: 1440, height: 1000 } });
  await page2.goto(BASE + "/");
  await page2.waitForSelector("#f-publish");
  await page2.click(`[data-open="${raceId}"]`);
  await page2.click('button[data-tab="rank"]');
  await page2.waitForFunction(() => document.querySelectorAll("#main tbody tr").length >= 4);
  const persistedRings = await page2.$$eval("#main tbody tr td:nth-child(2)", (els) => els.map((e) => e.textContent.trim()));
  check("重启后成绩仍可查询", persistedRings.includes("CHN-2026-004") && persistedRings.includes("CHN-2026-001"),
    persistedRings.join(","));
  await page2.click('button[data-tab="audit"]');
  await page2.waitForFunction(() => document.querySelectorAll("#main tbody tr").length > 5);
  check("重启后审计仍在", true);
  await page2.screenshot({ path: join(shotDir, "09-after-restart.png"), fullPage: true });
  await browser2.close();
} catch (e) {
  console.error("E2E 异常中止：", e.message);
  failures++;
  try { await page.screenshot({ path: join(shotDir, "error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close().catch(() => {});
  await stop(server);
}

console.log(`\n截图目录: ${shotDir}`);
console.log(failures === 0 ? "E2E 全部通过 ✅" : `E2E 有 ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
