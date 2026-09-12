import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.js";

const LOFT = "东港C棚";      // 本场圈定棚号
const OTHER_LOFT = "西山D棚"; // 未入选棚号

async function startApp(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pigeon-test-"));
  const dbPath = join(dir, "pigeons.json");
  const { server, store, ready } = createApp({ dbPath, ...options });
  await ready;
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    server,
    store,
    dbPath,
    dir,
    async close() {
      const done = new Promise(resolve => server.close(resolve));
      server.closeIdleConnections();
      await done;
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function api(base, path, { method = "GET", body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json() };
}

/** 造一场已放飞的 300 公里赛事:东港C棚 3 羽参赛,西山D棚 1 羽未入选。 */
async function setupReleasedRace(base) {
  for (const p of [
    { ringNo: "CHN-2026-101", owner: "张三", color: "灰", loft: LOFT },
    { ringNo: "CHN-2026-102", owner: "李四", color: "雨点", loft: LOFT },
    { ringNo: "CHN-2026-103", owner: "王五", color: "红轮", loft: LOFT },
    { ringNo: "CHN-2026-201", owner: "赵六", color: "白", loft: OTHER_LOFT }
  ]) {
    const res = await api(base, "/api/pigeons", { method: "POST", body: p });
    assert.equal(res.status, 201);
  }
  const created = await api(base, "/api/races", {
    method: "POST",
    body: { name: "300公里资格赛", distanceKm: 300, lofts: [LOFT] }
  });
  assert.equal(created.status, 201);
  const race = created.data;
  assert.equal(race.status, "draft");
  assert.deepEqual(race.roster, ["CHN-2026-101", "CHN-2026-102", "CHN-2026-103"], "按棚号自动圈定名单");
  await api(base, `/api/races/${race.id}/publish`, { method: "POST" });
  await api(base, `/api/races/${race.id}/release`, {
    method: "POST",
    body: { releaseTime: "2026-09-12T07:00:00.000Z" }
  });
  return race;
}

test("完整流程:发布赛事→圈定名单→放飞→报到生成分速与名次", async () => {
  const app = await startApp();
  try {
    const race = await setupReleasedRace(app.base);
    // 101 用时 300 分钟 → 分速 1000;102 用时 250 分钟 → 分速 1200(更快,应为第一)
    const c1 = await api(app.base, `/api/races/${race.id}/checkins`, {
      method: "POST",
      body: { ringNo: "CHN-2026-101", loft: LOFT, arrivalTime: "2026-09-12T12:00:00.000Z" }
    });
    assert.equal(c1.status, 201);
    assert.equal(c1.data.entry.speed, 1000);
    assert.equal(c1.data.entry.rank, 1);
    const c2 = await api(app.base, `/api/races/${race.id}/checkins`, {
      method: "POST",
      body: { ringNo: "CHN-2026-102", loft: LOFT, arrivalTime: "2026-09-12T11:10:00.000Z" }
    });
    assert.equal(c2.data.entry.speed, 1200);
    assert.equal(c2.data.entry.rank, 1, "分速更高者名次靠前");
    const detail = (await api(app.base, `/api/races/${race.id}`)).data;
    assert.equal(detail.checkins.find(c => c.ringNo === "CHN-2026-102").rank, 1);
    assert.equal(detail.checkins.find(c => c.ringNo === "CHN-2026-101").rank, 2, "名次随新报到自动重排");
  } finally {
    await app.close();
  }
});

test("拦截:重复报到", async () => {
  const app = await startApp();
  try {
    const race = await setupReleasedRace(app.base);
    const body = { ringNo: "CHN-2026-101", loft: LOFT, arrivalTime: "2026-09-12T12:00:00.000Z" };
    const first = await api(app.base, `/api/races/${race.id}/checkins`, { method: "POST", body });
    assert.equal(first.status, 201);
    const dup = await api(app.base, `/api/races/${race.id}/checkins`, { method: "POST", body });
    assert.equal(dup.status, 409);
    assert.equal(dup.data.error, "duplicate_checkin");
    const detail = (await api(app.base, `/api/races/${race.id}`)).data;
    assert.equal(detail.checkins.length, 1, "重复报到未产生第二笔记录");
  } finally {
    await app.close();
  }
});

test("拦截:并发重复报到只成功一笔", async () => {
  const app = await startApp();
  try {
    const race = await setupReleasedRace(app.base);
    const body = { ringNo: "CHN-2026-101", loft: LOFT, arrivalTime: "2026-09-12T12:00:00.000Z" };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => api(app.base, `/api/races/${race.id}/checkins`, { method: "POST", body }))
    );
    const ok = results.filter(r => r.status === 201);
    const dup = results.filter(r => r.status === 409 && r.data.error === "duplicate_checkin");
    assert.equal(ok.length, 1, "并发下仅一笔报到成功");
    assert.equal(dup.length, 9);
    const detail = (await api(app.base, `/api/races/${race.id}`)).data;
    assert.equal(detail.checkins.length, 1);
    // 磁盘文件与内存一致,无半笔记录
    const onDisk = JSON.parse(await readFile(app.dbPath, "utf8"));
    assert.equal(onDisk.races.find(r => r.id === race.id).checkins.length, 1);
  } finally {
    await app.close();
  }
});

test("拦截:并发不同鸽报到全部成功且名次正确", async () => {
  const app = await startApp();
  try {
    const race = await setupReleasedRace(app.base);
    const arrivals = {
      "CHN-2026-101": "2026-09-12T12:00:00.000Z", // 1000 米/分
      "CHN-2026-102": "2026-09-12T11:10:00.000Z", // 1200 米/分
      "CHN-2026-103": "2026-09-12T11:40:00.000Z"  // 1071.4286 米/分
    };
    const results = await Promise.all(
      Object.entries(arrivals).map(([ringNo, arrivalTime]) =>
        api(app.base, `/api/races/${race.id}/checkins`, { method: "POST", body: { ringNo, loft: LOFT, arrivalTime } }))
    );
    assert.ok(results.every(r => r.status === 201));
    const detail = (await api(app.base, `/api/races/${race.id}`)).data;
    const rankOf = ring => detail.checkins.find(c => c.ringNo === ring).rank;
    assert.equal(rankOf("CHN-2026-102"), 1);
    assert.equal(rankOf("CHN-2026-103"), 2);
    assert.equal(rankOf("CHN-2026-101"), 3);
    const onDisk = JSON.parse(await readFile(app.dbPath, "utf8"));
    assert.deepEqual(
      onDisk.races.find(r => r.id === race.id).checkins.map(c => [c.ringNo, c.rank]),
      detail.checkins.map(c => [c.ringNo, c.rank]),
      "并发落盘后磁盘与内存一致"
    );
  } finally {
    await app.close();
  }
});

test("拦截:未入选赛鸽", async () => {
  const app = await startApp();
  try {
    const race = await setupReleasedRace(app.base);
    // 西山D棚的鸽子已登记但未入选本场(本场只圈东港C棚)
    const res = await api(app.base, `/api/races/${race.id}/checkins`, {
      method: "POST",
      body: { ringNo: "CHN-2026-201", loft: OTHER_LOFT, arrivalTime: "2026-09-12T12:00:00.000Z" }
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error, "not_in_roster");
  } finally {
    await app.close();
  }
});

test("拦截:跨棚成绩", async () => {
  const app = await startApp();
  try {
    const race = await setupReleasedRace(app.base);
    // 入选鸽 101 档案棚号是东港C棚,却从西山D棚报到
    const res = await api(app.base, `/api/races/${race.id}/checkins`, {
      method: "POST",
      body: { ringNo: "CHN-2026-101", loft: OTHER_LOFT, arrivalTime: "2026-09-12T12:00:00.000Z" }
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.error, "cross_loft");
  } finally {
    await app.close();
  }
});

test("拦截:状态异常", async () => {
  const app = await startApp();
  try {
    const race = await setupReleasedRace(app.base);
    // 另建一场未放飞的赛事
    const draft = (await api(app.base, "/api/races", {
      method: "POST",
      body: { name: "200公里热身", distanceKm: 200, lofts: [LOFT] }
    })).data;
    const early = await api(app.base, `/api/races/${draft.id}/checkins`, {
      method: "POST",
      body: { ringNo: "CHN-2026-101", loft: LOFT, arrivalTime: "2026-09-12T12:00:00.000Z" }
    });
    assert.equal(early.status, 409);
    assert.equal(early.data.error, "invalid_status", "草稿状态不能报到");
    // 已发布未放飞同样拦截
    await api(app.base, `/api/races/${draft.id}/publish`, { method: "POST" });
    const stillEarly = await api(app.base, `/api/races/${draft.id}/checkins`, {
      method: "POST",
      body: { ringNo: "CHN-2026-101", loft: LOFT, arrivalTime: "2026-09-12T12:00:00.000Z" }
    });
    assert.equal(stillEarly.data.error, "invalid_status");
    // 重复放飞拦截
    const reRelease = await api(app.base, `/api/races/${race.id}/release`, {
      method: "POST",
      body: { releaseTime: "2026-09-12T08:00:00.000Z" }
    });
    assert.equal(reRelease.data.error, "invalid_status");
    // 归巢时间早于放飞时间拦截
    const badTime = await api(app.base, `/api/races/${race.id}/checkins`, {
      method: "POST",
      body: { ringNo: "CHN-2026-101", loft: LOFT, arrivalTime: "2026-09-12T06:00:00.000Z" }
    });
    assert.equal(badTime.data.error, "invalid_time");
  } finally {
    await app.close();
  }
});

test("审计留痕:名单、报到、排名、调整全程可查", async () => {
  const app = await startApp();
  try {
    const race = await setupReleasedRace(app.base);
    await api(app.base, `/api/races/${race.id}/checkins`, {
      method: "POST",
      body: { ringNo: "CHN-2026-101", loft: LOFT, arrivalTime: "2026-09-12T12:00:00.000Z" }
    });
    await api(app.base, `/api/races/${race.id}/checkins/CHN-2026-101/void`, {
      method: "POST",
      body: { reason: "扫描枪误读" }
    });
    const audit = (await api(app.base, `/api/audit?raceId=${race.id}`)).data;
    const actions = audit.map(a => a.action);
    for (const expected of ["race.create", "roster.set", "race.publish", "race.release", "checkin.record", "checkin.void"]) {
      assert.ok(actions.includes(expected), `审计缺少 ${expected}`);
    }
    const voided = (await api(app.base, `/api/races/${race.id}`)).data.checkins.find(c => c.ringNo === "CHN-2026-101");
    assert.equal(voided.status, "void");
    assert.equal(voided.voidReason, "扫描枪误读");
  } finally {
    await app.close();
  }
});

test("失败恢复:落盘失败回滚,不留半笔记录", async () => {
  let failNext = false;
  const app = await startApp({
    persistHook: async () => { if (failNext) { failNext = false; throw new Error("模拟磁盘写满"); } }
  });
  try {
    const race = await setupReleasedRace(app.base);
    const auditBefore = (await api(app.base, "/api/audit")).data.length;
    const fileBefore = await readFile(app.dbPath, "utf8");

    failNext = true;
    const res = await api(app.base, `/api/races/${race.id}/checkins`, {
      method: "POST",
      body: { ringNo: "CHN-2026-101", loft: LOFT, arrivalTime: "2026-09-12T12:00:00.000Z" }
    });
    assert.equal(res.status, 500, "落盘失败应返回错误");

    // 内存态回滚:没有这笔报到,也没有这笔审计
    const detail = (await api(app.base, `/api/races/${race.id}`)).data;
    assert.equal(detail.checkins.length, 0, "失败后的内存态不应残留报到");
    assert.equal((await api(app.base, "/api/audit")).data.length, auditBefore, "失败后的内存态不应残留审计");
    // 磁盘文件原样未动
    assert.equal(await readFile(app.dbPath, "utf8"), fileBefore, "落盘失败时磁盘文件保持原样");

    // 同一羽鸽可重新报到(未被误判为重复报到)
    const retry = await api(app.base, `/api/races/${race.id}/checkins`, {
      method: "POST",
      body: { ringNo: "CHN-2026-101", loft: LOFT, arrivalTime: "2026-09-12T12:00:00.000Z" }
    });
    assert.equal(retry.status, 201, "恢复后可正常报到");
  } finally {
    await app.close();
  }
});

test("失败恢复:服务重启后数据仍可查询", async () => {
  const app = await startApp();
  const race = await setupReleasedRace(app.base);
  await api(app.base, `/api/races/${race.id}/checkins`, {
    method: "POST",
    body: { ringNo: "CHN-2026-101", loft: LOFT, arrivalTime: "2026-09-12T12:00:00.000Z" }
  });
  const { dbPath, dir } = app;
  // 模拟服务重启:关掉 HTTP 服务,在同一数据文件上起新实例
  const closed = new Promise(resolve => app.server.close(resolve));
  app.server.closeIdleConnections();
  await closed;

  const again = createApp({ dbPath });
  await again.ready;
  await new Promise(resolve => again.server.listen(0, "127.0.0.1", resolve));
  const base2 = `http://127.0.0.1:${again.server.address().port}`;
  const detail = (await api(base2, `/api/races/${race.id}`)).data;
  assert.equal(detail.checkins.length, 1, "重启后报到记录仍在");
  assert.equal(detail.checkins[0].ringNo, "CHN-2026-101");
  const audit = (await api(base2, `/api/audit?raceId=${race.id}`)).data;
  assert.ok(audit.length >= 5, "重启后审计留痕仍在");
  const pigeons = (await api(base2, "/api/pigeons")).data;
  assert.ok(pigeons.some(p => p.ringNo === "CHN-2026-101"), "重启后鸽只档案仍在");
  const closed2 = new Promise(resolve => again.server.close(resolve));
  again.server.closeIdleConnections();
  await closed2;
  await rm(dir, { recursive: true, force: true });
});

test("旧档案入口照常可用", async () => {
  const app = await startApp();
  try {
    const home = await fetch(app.base + "/");
    assert.equal(home.status, 200);
    assert.match(await home.text(), /赛鸽血统环号登记站/);
    const list = await api(app.base, "/api/pigeons");
    assert.equal(list.status, 200);
    assert.ok(list.data.some(p => p.ringNo === "CHN-2026-001"), "种子档案仍在");
    const rel = await api(app.base, "/api/pigeons/CHN-2026-001/relation");
    assert.equal(rel.status, 200);
    assert.equal(rel.data.father.ringNo, "CHN-2022-188");
    const transfer = await api(app.base, "/api/pigeons/CHN-2026-001/transfers", { method: "POST", body: { to: "新鸽主" } });
    assert.equal(transfer.status, 200);
    const dup = await api(app.base, "/api/pigeons", { method: "POST", body: { ringNo: "CHN-2026-001", owner: "x", color: "灰", loft: "北岸A棚" } });
    assert.equal(dup.status, 409);
    assert.equal(dup.data.error, "ring_exists");
  } finally {
    await app.close();
  }
});
