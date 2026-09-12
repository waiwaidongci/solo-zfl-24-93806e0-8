import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

const BASE = "http://localhost:3024";
const SHOTS = new URL("../verification/", import.meta.url).pathname;
await mkdir(SHOTS, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("dialog", dialog => dialog.accept("足环扫描异常"));

let stepNo = 0;
async function step(name, shot) {
  stepNo += 1;
  if (shot) await page.screenshot({ path: `${SHOTS}${String(stepNo).padStart(2, "0")}-${shot}.png`, fullPage: true });
  console.log(`✅ ${stepNo}. ${name}`);
}

// ---------- 1. 旧档案入口照常可用 ----------
await page.goto(BASE + "/", { waitUntil: "networkidle" });
assert.match(await page.textContent("h1"), /赛鸽血统环号登记站/);
// 通过旧档案表单登记一羽新鸽
await page.fill('input[name="ringNo"]', "CHN-2026-104");
await page.fill('input[name="owner"]', "钱七");
await page.fill('input[name="color"]', "麒麟花");
await page.fill('input[name="loft"]', "北岸A棚");
await page.click("#form button");
await page.waitForSelector('text=CHN-2026-104');
// 血统查询
await page.fill("#search", "CHN-2026-001");
await page.click("#searchBtn");
await page.waitForSelector('text=CHN-2022-188');
await step("旧档案入口:建档案、血统查询正常", "old-archive");

// ---------- 2. 发布赛事并按棚号圈定名单 ----------
await page.goto(BASE + "/races", { waitUntil: "networkidle" });
await page.fill("#raceName", "300公里资格赛");
await page.fill("#raceDistance", "300");
await page.check('#loftChecks input[value="北岸A棚"]');
await page.click("#btnCreate");
await page.waitForSelector("#okBox", { state: "visible" });
assert.match(await page.textContent("#okBox"), /圈定 5 羽/); // CHN-2026-001/101/102/103/104
assert.match(await page.textContent("#rosterView"), /CHN-2026-001/);
await step("发布赛事:按棚号自动圈定 5 羽名单", "race-created");

// ---------- 3. 名单锁定 + 记录放飞时间 ----------
await page.click("#btnPublish");
await page.waitForSelector("#releaseTime");
assert.match(await page.textContent("#raceDetail"), /已发布/);
await page.fill("#releaseTime", "2026-09-12T07:00");
await page.click("#btnRelease");
await page.waitForSelector("#ciRing");
assert.match(await page.textContent("#raceDetail"), /已放飞/);
await step("赛事发布、名单锁定、放飞时间已记录", "released");

// ---------- 4. 归巢报到:分速与名次 ----------
async function checkin(ring, loft, arrival) {
  await page.fill("#ciRing", ring);
  await page.fill("#ciLoft", loft);
  await page.fill("#ciArrival", arrival);
  await page.evaluate(() => {
    document.querySelector("#errorBox").style.display = "none";
    document.querySelector("#okBox").style.display = "none";
  });
  await Promise.all([
    page.waitForResponse(r => r.url().includes("/checkins") && r.request().method() === "POST"),
    page.click("#btnCheckin")
  ]);
  await page.waitForFunction(() => {
    const e = document.querySelector("#errorBox"), o = document.querySelector("#okBox");
    return (e && e.style.display === "block") || (o && o.style.display === "block");
  });
}
await checkin("CHN-2026-101", "北岸A棚", "2026-09-12T12:00");
assert.match(await page.textContent("#okBox"), /分速 1000.*第 1 名/);
await checkin("CHN-2026-102", "北岸A棚", "2026-09-12T11:10");
assert.match(await page.textContent("#okBox"), /分速 1200.*第 1 名/);
await checkin("CHN-2026-103", "北岸A棚", "2026-09-12T11:40");
assert.match(await page.textContent("#okBox"), /第 2 名/);
await page.waitForFunction(() => document.querySelectorAll("#board tbody tr").length === 3);
const rows = await page.$$eval("#board tbody tr", trs => trs.map(tr => [...tr.children].slice(0, 3).map(td => td.textContent)));
assert.deepEqual(rows.map(r => r[1]), ["CHN-2026-102", "CHN-2026-103", "CHN-2026-101"], "名次按分速排序");
assert.deepEqual(rows.map(r => r[0]), ["1", "2", "3"]);
await step("归巢报到:分速计算正确,名次自动重排", "board");

// ---------- 5. 四类拦截 ----------
await checkin("CHN-2026-101", "北岸A棚", "2026-09-12T12:30");
assert.match(await page.textContent("#errorBox"), /重复报到/);
await step("拦截①:重复报到被拒", "intercept-duplicate");

await checkin("CHN-2026-201", "南山B棚", "2026-09-12T12:00");
assert.match(await page.textContent("#errorBox"), /未入选/);
await step("拦截②:未入选赛鸽被拒", "intercept-roster");

await checkin("CHN-2026-104", "南山B棚", "2026-09-12T12:00");
assert.match(await page.textContent("#errorBox"), /跨棚/);
await step("拦截③:跨棚成绩被拒", "intercept-cross-loft");

const statusResult = await page.evaluate(async () => {
  const created = await (await fetch("/api/races", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "200公里热身", distanceKm: 200, lofts: ["北岸A棚"] }) })).json();
  const res = await fetch(`/api/races/${created.id}/checkins`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ringNo: "CHN-2026-101", loft: "北岸A棚", arrivalTime: "2026-09-12T12:00:00Z" }) });
  return { status: res.status, body: await res.json() };
});
assert.equal(statusResult.status, 409);
assert.equal(statusResult.body.error, "invalid_status");
await step("拦截④:未放飞赛事报到被拒(状态异常)", "intercept-status");

// ---------- 6. 调整动作:作废报到,名次重排 ----------
await Promise.all([
  page.waitForResponse(r => r.url().includes("/void") && r.request().method() === "POST"),
  page.click('[data-void="CHN-2026-103"]')
]);
await page.waitForFunction(() => document.querySelector("#okBox").textContent.includes("已作废"));
assert.match(await page.textContent("#okBox"), /已作废并重排名次/);
await page.waitForFunction(() => document.querySelectorAll("#board tbody tr:not(.void-row)").length === 2);
const rowsAfterVoid = await page.$$eval("#board tbody tr:not(.void-row)", trs => trs.map(tr => tr.children[1].textContent));
assert.deepEqual(rowsAfterVoid, ["CHN-2026-102", "CHN-2026-101"], "作废后名次重排");
await step("调整动作:作废 103 报到,101 递补第 2 名", "void");

// ---------- 7. 审计留痕 ----------
await page.waitForFunction(() => document.querySelector("#auditLog").textContent.includes("checkin.void"));
const auditText = await page.textContent("#auditLog");
for (const action of ["race.create", "roster.set", "race.publish", "race.release", "checkin.record", "checkin.void"]) {
  assert.ok(auditText.includes(action), `审计缺少 ${action}`);
}
await step("审计留痕:名单/放飞/报到/作废全程可查", "audit");

// ---------- 8. 封存赛事 ----------
await Promise.all([
  page.waitForResponse(r => r.url().includes("/close") && r.request().method() === "POST"),
  page.click("#btnClose")
]);
await page.waitForFunction(() => document.querySelector("#raceDetail").textContent.includes("已封存"));
assert.match(await page.textContent("#raceDetail"), /已封存/);
await step("赛事封存,名次定稿", "closed");

await browser.close();
console.log("\n全部浏览器验证通过 ✔");
