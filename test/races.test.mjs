import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, cp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function makeDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "pigeon-test-"));
  await cp(join(root, "data", "pigeons.json"), join(dir, "pigeons.json"));
  return dir;
}

async function startServer({ dataDir, port = 4319, failpoint = true }) {
  const child = spawn(process.execPath, [join(root, "server.js")], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), FAILPOINT: failpoint ? "1" : "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => { logs += d; });
  child.stderr.on("data", (d) => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      const r = await fetch(base + "/api/pigeons");
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("server did not start: " + logs);
    await new Promise((r) => setTimeout(r, 80));
  }
  return {
    child, base,
    stop: () => new Promise((resolve) => { child.kill("SIGTERM"); child.on("exit", resolve); }),
  };
}

async function post(base, path, body) {
  const res = await fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function prepareRace(base) {
  const race = (await post(base, "/api/races", { name: "测试赛", distance: 300, releasePoint: "鹤壁" })).json;
  await post(base, `/api/races/${race.id}/entries/select`, { lofts: ["北岸A棚"] });
  await post(base, `/api/races/${race.id}/release`, { releaseAt: "2026-09-12T08:00:00+08:00" });
  return race.id;
}

describe("赛事运营回归", () => {
  let dataDir, server;
  before(async () => {
    dataDir = await makeDataDir();
    server = await startServer({ dataDir });
  });
  after(async () => { await server?.stop(); });

  test("分速与名次：300公里不同归巢时间", async () => {
    const rid = await prepareRace(server.base);
    // 240 分钟 -> 1250.00；210 分钟 -> 1428.57；225 分钟 -> 1333.33
    const cases = [
      ["CHN-2026-001", "2026-09-12T12:00:00+08:00", 1250],
      ["CHN-2026-002", "2026-09-12T11:30:00+08:00", 1428.57],
      ["CHN-2026-003", "2026-09-12T11:45:00+08:00", 1333.33],
    ];
    for (const [ring, at] of cases) {
      const r = await post(server.base, `/api/races/${rid}/checkins`, { ringNo: ring, arriveAt: at });
      assert.equal(r.status, 201);
    }
    const race = await (await fetch(`${server.base}/api/races/${rid}`)).json();
    const byRing = Object.fromEntries(race.checkins.map((c) => [c.ringNo, c]));
    assert.equal(byRing["CHN-2026-002"].rank, 1);
    assert.equal(byRing["CHN-2026-003"].rank, 2);
    assert.equal(byRing["CHN-2026-001"].rank, 3);
    assert.equal(byRing["CHN-2026-001"].speed, 1250);
    assert.equal(byRing["CHN-2026-002"].speed, 1428.57);
  });

  test("重复报到拦截：第二次 400，只有一条报到，拦截写审计", async () => {
    const rid = await prepareRace(server.base);
    const a = await post(server.base, `/api/races/${rid}/checkins`, { ringNo: "CHN-2026-001", arriveAt: "2026-09-12T12:00:00+08:00" });
    const b = await post(server.base, `/api/races/${rid}/checkins`, { ringNo: "CHN-2026-001", arriveAt: "2026-09-12T12:05:00+08:00" });
    assert.equal(a.status, 201);
    assert.equal(b.status, 400);
    assert.equal(b.json.error, "duplicate_checkin");
    const race = await (await fetch(`${server.base}/api/races/${rid}`)).json();
    assert.equal(race.checkins.filter((c) => c.ringNo === "CHN-2026-001").length, 1);
    assert.equal(race.checkins[0].arriveAt, "2026-09-12T04:00:00.000Z");
    const audit = await (await fetch(`${server.base}/api/audit?target=${rid}`)).json();
    assert.ok(audit.some((e) => e.action === "checkin" && e.detail.ringNo === "CHN-2026-001"));
    const rej = audit.filter((e) => e.action === "checkin_rejected" && e.detail.ringNo === "CHN-2026-001");
    assert.equal(rej.length, 1);
    assert.equal(rej[0].detail.reason, "duplicate_checkin");
  });

  test("并发报到：同一鸽两个并发请求恰好一个成功", async () => {
    const rid = await prepareRace(server.base);
    const payload = { ringNo: "CHN-2026-002", arriveAt: "2026-09-12T11:30:00+08:00" };
    const [r1, r2] = await Promise.all([
      post(server.base, `/api/races/${rid}/checkins`, payload),
      post(server.base, `/api/races/${rid}/checkins`, payload),
    ]);
    const status = [r1.status, r2.status].sort().join(",");
    assert.equal(status, "201,400");
    assert.ok([r1, r2].some((r) => r.json.error === "duplicate_checkin"));
    const race = await (await fetch(`${server.base}/api/races/${rid}`)).json();
    assert.equal(race.checkins.filter((c) => c.ringNo === "CHN-2026-002").length, 1);
  });

  test("并发报到：多羽同时归巢全部成功，名次连续完整", async () => {
    const rid = await prepareRace(server.base);
    const times = {
      "CHN-2026-001": "2026-09-12T12:00:00+08:00",
      "CHN-2026-002": "2026-09-12T11:30:00+08:00",
      "CHN-2026-003": "2026-09-12T11:45:00+08:00",
      "CHN-2026-004": "2026-09-12T11:50:00+08:00",
      "CHN-2026-011": "2026-09-12T11:55:00+08:00",
    };
    const results = await Promise.all(
      Object.entries(times).map(([ringNo, at]) => post(server.base, `/api/races/${rid}/checkins`, { ringNo, arriveAt: at }))
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 201, 201, 201, 201]);
    const race = await (await fetch(`${server.base}/api/races/${rid}`)).json();
    assert.equal(race.checkins.length, 5);
    assert.deepEqual(race.checkins.map((c) => c.rank), [1, 2, 3, 4, 5]);
  });

  test("拦截：未入选 / 跨棚 / 状态异常 / 早于放飞", async () => {
    const rid = await prepareRace(server.base);
    const check = async (body, code) => {
      const r = await post(server.base, `/api/races/${rid}/checkins`, body);
      assert.equal(r.status, 400, `${body.ringNo} 应被拦截`);
      assert.equal(r.json.error, code);
    };
    // 未入选（东风B棚，不在北岸A棚名单）
    await check({ ringNo: "CHN-2026-005", arriveAt: "2026-09-12T11:40:00+08:00" }, "pigeon_not_in_entries");
    // 未登记
    await check({ ringNo: "CHN-1900-999", arriveAt: "2026-09-12T11:40:00+08:00" }, "pigeon_not_found");
    // 跨棚：入选鸽但申报棚号与登记棚不符
    await check({ ringNo: "CHN-2026-001", arriveAt: "2026-09-12T11:41:00+08:00", loft: "东风B棚" }, "cross_loft_result");
    // 早于放飞
    await check({ ringNo: "CHN-2026-002", arriveAt: "2026-09-12T07:59:00+08:00" }, "arrive_before_release");
    // 状态异常
    const st = await post(server.base, "/api/pigeons/CHN-2026-003/status", { status: "失格", reason: "测试" });
    assert.equal(st.status, 200);
    await check({ ringNo: "CHN-2026-003", arriveAt: "2026-09-12T11:42:00+08:00" }, "pigeon_abnormal");

    const race0 = await (await fetch(`${server.base}/api/races/${rid}`)).json();
    assert.equal(race0.checkins.length, 0);
    const audit = await (await fetch(`${server.base}/api/audit?target=${rid}`)).json();
    const reasons = audit.filter((e) => e.result === "rejected").map((e) => e.detail.reason);
    for (const code of ["pigeon_not_in_entries", "pigeon_not_found", "cross_loft_result", "arrive_before_release", "pigeon_abnormal"]) {
      assert.ok(reasons.includes(code), `审计缺少拦截原因 ${code}`);
    }
    // 复位状态，避免影响本 describe 后续用例的按棚圈定
    await post(server.base, "/api/pigeons/CHN-2026-003/status", { status: "正常", reason: "测试复位" });
  });

  test("圈定时状态异常鸽自动跳过且写审计", async () => {
    await post(server.base, "/api/pigeons/CHN-2026-004/status", { status: "伤病", reason: "检疫观察" });
    const rid2 = (await post(server.base, "/api/races", { name: "测试赛2", distance: 200 })).json.id;
    const r = await post(server.base, `/api/races/${rid2}/entries/select`, { lofts: ["北岸A棚"] });
    const rings = r.json.entries.map((e) => e.ringNo);
    assert.ok(!rings.includes("CHN-2026-004"), "伤病鸽不应入选");
    assert.ok(rings.includes("CHN-2026-001"));
    const audit = await (await fetch(`${server.base}/api/audit?target=${rid2}`)).json();
    const sel = audit.find((e) => e.action === "entries_select");
    assert.ok(sel.detail.skippedAbnormal.includes("CHN-2026-004"));
    await post(server.base, "/api/pigeons/CHN-2026-004/status", { status: "正常", reason: "测试复位" });
  });

  test("放飞后名单锁定", async () => {
    const rid = await prepareRace(server.base);
    const r = await post(server.base, `/api/races/${rid}/entries`, { ringNo: "CHN-2026-005" });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "race_locked");
  });

  test("调整归巢时间：PUT 请求体生效，名次重算并写审计", async () => {
    const rid = await prepareRace(server.base);
    await post(server.base, `/api/races/${rid}/checkins`, { ringNo: "CHN-2026-001", arriveAt: "2026-09-12T12:00:00+08:00" });
    const put = await fetch(`${server.base}/api/races/${rid}/checkins/CHN-2026-001`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arriveAt: "2026-09-12T11:20:00+08:00", reason: "纠偏" }),
    });
    assert.equal(put.status, 200);
    const race = await put.json();
    assert.equal(race.checkins[0].ringNo, "CHN-2026-001");
    assert.equal(race.checkins[0].rank, 1);
    assert.equal(race.checkins[0].speed, 1500); // 300km / 200min
    const audit = await (await fetch(`${server.base}/api/audit?target=${rid}`)).json();
    assert.ok(audit.some((e) => e.action === "checkin_adjust"));
  });
});

describe("失败恢复：写盘失败不留半条数据", () => {
  let dataDir, server;
  before(async () => {
    dataDir = await makeDataDir();
    server = await startServer({ dataDir, port: 4320 });
  });
  after(async () => { await server?.stop(); });

  test("报到写盘失败：报到与审计都不落盘，内存同步回滚，后续请求正常", async () => {
    const rid = await prepareRace(server.base);
    const beforeRace = await (await fetch(`${server.base}/api/races/${rid}`)).json();
    const beforeAudit = await (await fetch(`${server.base}/api/audit?target=${rid}`)).json();

    await post(server.base, "/api/test/fail-next-write", { count: 1 });
    const r = await post(server.base, `/api/races/${rid}/checkins`, {
      ringNo: "CHN-2026-001", arriveAt: "2026-09-12T12:00:00+08:00",
    });
    assert.equal(r.status, 500);

    const afterRace = await (await fetch(`${server.base}/api/races/${rid}`)).json();
    assert.equal(afterRace.checkins.length, beforeRace.checkins.length);
    assert.equal(afterRace.checkins.length, 0);
    const afterAudit = await (await fetch(`${server.base}/api/audit?target=${rid}`)).json();
    assert.equal(afterAudit.length, beforeAudit.length);

    // 磁盘文件也没有半条数据，且无遗留临时文件
    const onDisk = JSON.parse(await readFile(join(dataDir, "races.json"), "utf8"));
    const persisted = onDisk.races.find((x) => x.id === rid);
    assert.equal(persisted.checkins.length, 0);
    const leftovers = (await readdir(dataDir)).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(leftovers, []);

    // 故障清除后立即重试成功
    const retry = await post(server.base, `/api/races/${rid}/checkins`, {
      ringNo: "CHN-2026-001", arriveAt: "2026-09-12T12:00:00+08:00",
    });
    assert.equal(retry.status, 201);
    assert.equal(retry.json.rank, 1);
  });

  test("圈定写盘失败：名单不变、审计不留、可重新圈定", async () => {
    const rid = (await post(server.base, "/api/races", { name: "失败圈定赛", distance: 300 })).json.id;
    await post(server.base, "/api/test/fail-next-write", { count: 1 });
    const r = await post(server.base, `/api/races/${rid}/entries/select`, { lofts: ["北岸A棚"] });
    assert.equal(r.status, 500);
    const race = await (await fetch(`${server.base}/api/races/${rid}`)).json();
    assert.equal(race.entries.length, 0);
    const audit = await (await fetch(`${server.base}/api/audit?target=${rid}`)).json();
    assert.equal(audit.filter((e) => e.action === "entries_select").length, 0);
    const ok = await post(server.base, `/api/races/${rid}/entries/select`, { lofts: ["东风B棚"] });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.entries.length, 3);
  });
});

describe("重启持久化与旧档案", () => {
  let dataDir, server, rid;
  before(async () => {
    dataDir = await makeDataDir();
    server = await startServer({ dataDir, port: 4321 });
    rid = await prepareRace(server.base);
    await post(server.base, `/api/races/${rid}/checkins`, { ringNo: "CHN-2026-002", arriveAt: "2026-09-12T11:30:00+08:00" });
  });
  after(async () => { await server?.stop(); });

  test("服务重启后赛事、名单、报到、名次、审计全部可查", async () => {
    await server.stop();
    server = await startServer({ dataDir, port: 4321 });
    const race = await (await fetch(`${server.base}/api/races/${rid}`)).json();
    assert.equal(race.status, "released");
    assert.equal(race.entries.length, 5);
    assert.equal(race.checkins.length, 1);
    assert.equal(race.checkins[0].ringNo, "CHN-2026-002");
    assert.equal(race.checkins[0].rank, 1);
    assert.equal(race.checkins[0].speed, 1428.57);
    const audit = await (await fetch(`${server.base}/api/audit`)).json();
    assert.ok(audit.some((e) => e.action === "race_release"));
    assert.ok(audit.some((e) => e.action === "checkin"));
  });

  test("旧档案入口可访问，且与新系统共用同一份赛鸽数据", async () => {
    const home = await fetch(`${server.base}/legacy/`);
    assert.equal(home.status, 200);
    const text = await home.text();
    assert.ok(text.includes("赛鸽血统环号登记站"));
    const legacy = await (await fetch(`${server.base}/legacy/api/pigeons`)).json();
    const fresh = await (await fetch(`${server.base}/api/pigeons`)).json();
    assert.equal(legacy.length, fresh.length);
    // 旧站新建档案，新站立刻可见
    const add = await fetch(`${server.base}/legacy/api/pigeons`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ringNo: "CHN-2026-900", owner: "旧站", color: "灰", loft: "东风B棚" }),
    });
    assert.equal(add.status, 201);
    const after = await (await fetch(`${server.base}/api/pigeons`)).json();
    assert.ok(after.some((p) => p.ringNo === "CHN-2026-900"));
  });
});
