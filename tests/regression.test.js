import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = join(import.meta.dirname, "..");
const PORT = 3091;
const BASE = `http://127.0.0.1:${PORT}`;

let serverProc = null;
let dataDir = null;

function startServer(envPort = PORT) {
  const proc = spawn(process.execPath, [join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(envPort), DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stdout.on("data", d => process.stdout.write(`[srv] ${d}`));
  proc.stderr.on("data", d => process.stderr.write(`[srv] ${d}`));
  return proc;
}

async function waitHealthy(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("server did not become healthy");
}

async function post(path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}
const get = path => fetch(BASE + path).then(r => r.json());

async function setupRace() {
  const race = await (await fetch(BASE + "/api/races", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "回归测试赛", distance: 500000, lofts: ["北岸A棚", "南岸B棚"] })
  })).json();
  await post(`/api/races/${race.id}/roster`, { lofts: ["北岸A棚", "南岸B棚"] });
  await post(`/api/races/${race.id}/release`, { releaseAt: "2026-09-20T07:00" });
  return race.id;
}

describe("赛事运营回归", () => {
  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pigeon-reg-"));
    cpSync(join(ROOT, "data", "pigeons.json"), join(dataDir, "pigeons.json"));
    serverProc = startServer();
    await waitHealthy();
  });
  after(async () => {
    serverProc?.kill("SIGTERM");
    await sleep(200);
  });

  test("旧档案迁移：pigeons.json 中的历史档案可查询，血统关系保留", async () => {
    const list = await get("/legacy/api/pigeons");
    const old = list.find(p => p.ringNo === "CHN-2026-001");
    assert.ok(old, "旧档案 CHN-2026-001 必须迁移成功");
    assert.equal(old.loft, "北岸A棚");
    const rel = await (await fetch(BASE + "/legacy/api/pigeons/CHN-2026-001/relation")).json();
    assert.equal(rel.father.ringNo, "CHN-2022-188");
    assert.equal(rel.mother.ringNo, "CHN-2023-512");
    assert.ok(rel.pigeon.races.some(r => r.event === "120公里训放"), "旧成绩必须保留");
  });

  test("圈定名单：正常鸽入选，伤病鸽剔除，圈定动作有审计", async () => {
    const rid = await setupRace();
    const detail = await get(`/api/races/${rid}`);
    const rings = detail.entries.map(e => e.ring_no);
    assert.ok(rings.includes("CHN-2026-101"));
    assert.ok(!rings.includes("CHN-2026-103"), "伤病鸽 103 不得入选");
    const logs = await get(`/api/audit?entityType=race&entityId=${rid}`);
    const rosterLog = logs.find(l => l.action === "roster.select" && l.result === "success");
    assert.ok(rosterLog);
    assert.deepEqual(rosterLog.detail.skipped.map(s => s.ringNo), ["CHN-2026-103"]);
  });

  test("重复报到拦截：同一羽赛鸽第二次报到被拒且只产生一条成绩", async () => {
    const rid = await setupRace();
    const first = await post(`/api/races/${rid}/arrivals`, { ringNo: "CHN-2026-201", arrivedAt: "2026-09-20T13:10" });
    assert.equal(first.status, 201);
    const dup = await post(`/api/races/${rid}/arrivals`, { ringNo: "CHN-2026-201", arrivedAt: "2026-09-20T14:00" });
    assert.equal(dup.status, 422);
    assert.equal(dup.json.error, "duplicate_arrival");
    const detail = await get(`/api/races/${rid}`);
    assert.equal(detail.arrivals.filter(a => a.ring_no === "CHN-2026-201").length, 1);
    const denied = detail.audit.filter(l => l.result === "denied" && l.detail.code === "duplicate_arrival");
    assert.equal(denied.length, 1, "拒绝事件必须留痕且只有一条");
  });

  test("并发报到：12 个并发同环请求恰好 1 条成功，其余全部拦截", async () => {
    const rid = await setupRace();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        post(`/api/races/${rid}/arrivals`, { ringNo: "CHN-2026-202", arrivedAt: "2026-09-20T13:05" }, { "x-request-id": `cc-${i}` }))
    );
    const ok = results.filter(r => r.status === 201);
    const blocked = results.filter(r => r.status === 422 && r.json.error === "duplicate_arrival");
    assert.equal(ok.length, 1, `成功数应为 1，实际 ${ok.length}`);
    assert.equal(blocked.length, 11, `拦截数应为 11，实际 ${blocked.length}`);
    const detail = await get(`/api/races/${rid}`);
    assert.equal(detail.arrivals.filter(a => a.ring_no === "CHN-2026-202").length, 1);
  });

  test("失败恢复：故障注入后整笔回滚无半笔记录，重试成功", async () => {
    const rid = await setupRace();
    await post(`/api/races/${rid}/arrivals`, { ringNo: "CHN-2026-203", arrivedAt: "2026-09-20T13:20" });
    const before = await get(`/api/races/${rid}`);
    const countBefore = before.arrivals.length;
    const rankBefore = before.arrivals.map(a => [a.rank, a.ring_no]);

    const failed = await post(`/api/races/${rid}/arrivals`,
      { ringNo: "CHN-2026-202", arrivedAt: "2026-09-20T13:05" },
      { "x-fault": "arrival-insert" });
    assert.equal(failed.status, 500, "故障注入应返回 500");

    const after = await get(`/api/races/${rid}`);
    assert.equal(after.arrivals.length, countBefore, "失败后成绩数量必须不变（无半笔）");
    assert.ok(!after.arrivals.some(a => a.ring_no === "CHN-2026-202"), "失败插入的报到必须回滚");
    assert.deepEqual(after.arrivals.map(a => [a.rank, a.ring_no]), rankBefore, "失败不得改动名次");
    assert.ok(!after.audit.some(l => l.action === "rank.recompute" && l.detail.reason === "checkin:CHN-2026-202"),
      "失败事务中的重排审计也必须回滚");

    // 恢复：去掉故障头后正常报到成功
    const retry = await post(`/api/races/${rid}/arrivals`, { ringNo: "CHN-2026-202", arrivedAt: "2026-09-20T13:05" });
    assert.equal(retry.status, 201);
    assert.equal(retry.json.ring_no, "CHN-2026-202");
    assert.equal(retry.json.rank, 1, "13:05 归巢应为第 1 名");
  });

  test("拦截矩阵：未入选、跨棚、状态异常、放飞前、关闭后", async () => {
    const rid = await setupRace();
    const released = await get(`/api/races/${rid}`);
    assert.equal(released.status, "released");

    const notEntered = await post(`/api/races/${rid}/arrivals`, { ringNo: "CHN-2026-301", arrivedAt: "2026-09-20T13:20" });
    assert.equal(notEntered.json.error, "not_entered");
    const unknown = await post(`/api/races/${rid}/arrivals`, { ringNo: "CHN-9999-999", arrivedAt: "2026-09-20T13:20" });
    assert.equal(unknown.json.error, "pigeon_not_found");

    // 入名单后转棚 → 跨棚拦截
    await post("/api/pigeons/CHN-2026-104/transfer", { loft: "西二C棚" });
    const cross = await post(`/api/races/${rid}/arrivals`, { ringNo: "CHN-2026-104", arrivedAt: "2026-09-20T13:20" });
    assert.equal(cross.json.error, "cross_loft");
    await post("/api/pigeons/CHN-2026-104/transfer", { loft: "北岸A棚" });

    // 入选鸽放飞后状态变异常 → 报到拦截
    await post("/api/pigeons/CHN-2026-102/status", { status: "injured" });
    const abnormal = await post(`/api/races/${rid}/arrivals`, { ringNo: "CHN-2026-102", arrivedAt: "2026-09-20T13:20" });
    assert.equal(abnormal.json.error, "abnormal_status");
    await post("/api/pigeons/CHN-2026-102/status", { status: "normal" });

    // 关闭后拦截
    await post(`/api/races/${rid}/close`, {});
    const closed = await post(`/api/races/${rid}/arrivals`, { ringNo: "CHN-2026-101", arrivedAt: "2026-09-20T13:20" });
    assert.equal(closed.json.error, "race_closed");
  });

  test("成绩调整留痕并重算名次；分速=距离/用时（米/分）", async () => {
    const rid = await setupRace();
    await post(`/api/races/${rid}/arrivals`, { ringNo: "CHN-2026-101", arrivedAt: "2026-09-20T13:40" });
    await post(`/api/races/${rid}/arrivals`, { ringNo: "CHN-2026-201", arrivedAt: "2026-09-20T13:10" });
    let detail = await get(`/api/races/${rid}`);
    const first = detail.arrivals.find(a => a.ring_no === "CHN-2026-201");
    assert.equal(first.rank, 1);
    assert.equal(first.speed_m_per_min, 1351.351); // 500000m / 370min

    const adjusted = await post(`/api/races/${rid}/arrivals/CHN-2026-201/adjust`,
      { arrivedAt: "2026-09-20T13:50", reason: "计时设备更正" });
    assert.equal(adjusted.status, 200);
    const r201 = adjusted.json.arrivals.find(a => a.ring_no === "CHN-2026-201");
    const r101 = adjusted.json.arrivals.find(a => a.ring_no === "CHN-2026-101");
    assert.equal(r101.rank, 1); assert.equal(r201.rank, 2);
    const logs = await get(`/api/audit?entityType=race&entityId=${rid}`);
    assert.ok(logs.some(l => l.action === "arrival.adjust" && l.detail.reason === "计时设备更正"));
  });
});

describe("重启持久化", () => {
  test("服务重启后赛事、名单、成绩、审计均可查询", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pigeon-restart-"));
    cpSync(join(ROOT, "data", "pigeons.json"), join(dir, "pigeons.json"));
    const proc = startServerOn(3096, dir);
    try {
      await waitHealthyOn(3096);
      const create = await fetch(`http://127.0.0.1:3096/api/races`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "持久化赛", distance: 420000, lofts: ["北岸A棚"] })
      }).then(r => r.json());
      await postOn(3096, `/api/races/${create.id}/roster`, { lofts: ["北岸A棚"] });
      await postOn(3096, `/api/races/${create.id}/release`, { releaseAt: "2026-09-20T07:00" });
      await postOn(3096, `/api/races/${create.id}/arrivals`, { ringNo: "CHN-2026-101", arrivedAt: "2026-09-20T12:00" });
      proc.kill("SIGTERM");
      await sleep(400);
      assert.ok(!existsSync(join(dir, "racing.db-journal")), "不应残留回滚日志");

      const proc2 = startServerOn(3096, dir);
      await waitHealthyOn(3096);
      const detail = await fetch(`http://127.0.0.1:3096/api/races/${create.id}`).then(r => r.json());
      assert.equal(detail.name, "持久化赛");
      assert.equal(detail.status, "released");
      assert.equal(detail.arrivals[0].ring_no, "CHN-2026-101");
      assert.equal(detail.arrivals[0].speed_m_per_min, +(420000 / 300).toFixed(3));
      assert.ok(detail.audit.some(l => l.action === "race.publish"));
      proc2.kill("SIGTERM");
      await sleep(200);
    } finally {
      proc.kill("SIGTERM");
    }
  });
});

function startServerOn(port, dir) {
  const proc = spawn(process.execPath, [join(ROOT, "server.js")], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: dir }, stdio: "ignore"
  });
  return proc;
}
async function waitHealthyOn(port) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error(`server on ${port} not healthy`);
}
async function postOn(port, path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
