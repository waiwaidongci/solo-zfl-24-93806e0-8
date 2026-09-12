// 赛事运营核心业务逻辑。所有写操作通过 better-sqlite3 同步事务提交，
// 事务内任何一步抛错都会整体回滚，杜绝半笔记录。

export class HttpError extends Error {
  constructor(status, code, message, audit) {
    super(message);
    this.status = status;
    this.code = code;
    this.audit = audit; // {action, entityType, entityId, detail} 拒绝事件留痕
  }
}

const VALID_STATUS = new Set(["normal", "injured", "lost", "dead"]);
const STATUS_TEXT = { normal: "正常", injured: "伤病", lost: "迷失", dead: "亡故" };

function nowIso() { return new Date().toISOString(); }

function parseTime(value, field) {
  if (!value) throw new HttpError(400, "invalid_input", `${field}不能为空`);
  const t = new Date(typeof value === "string" && value.includes("T") ? value : String(value).replace(" ", "T"));
  if (Number.isNaN(t.getTime())) throw new HttpError(400, "invalid_input", `${field}时间格式无效: ${value}`);
  return t;
}

export function writeAudit(db, { actor = "admin", action, entityType, entityId = "", result = "success", detail = {}, requestId = "" }) {
  db.prepare(`INSERT INTO audit_logs (actor, action, entity_type, entity_id, result, detail, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(actor, action, entityType, String(entityId), result, JSON.stringify(detail), requestId);
}

// 规则校验失败也要留痕：先独立事务写拒绝日志，再抛错（业务数据从未改动）
function deny(db, reqId, actor, action, entityType, entityId, code, message, detail = {}) {
  writeAudit(db, { actor, action, entityType, entityId, result: "denied", detail: { code, ...detail }, requestId: reqId });
  throw new HttpError(422, code, message);
}

function getRace(db, id) {
  const race = db.prepare("SELECT * FROM races WHERE id = ?").get(id);
  if (!race) throw new HttpError(404, "race_not_found", "赛事不存在");
  race.allowed_lofts = JSON.parse(race.allowed_lofts || "[]");
  return race;
}

// ---------- 赛鸽 ----------
export function listPigeons(db) {
  return db.prepare("SELECT * FROM pigeons ORDER BY loft_no, ring_no").all()
    .map(p => ({ ...p, statusText: STATUS_TEXT[p.status] || p.status }));
}

export function setPigeonStatus(db, ringNo, status, { actor, requestId }) {
  if (!VALID_STATUS.has(status)) throw new HttpError(400, "invalid_input", "状态非法");
  const pigeon = db.prepare("SELECT * FROM pigeons WHERE ring_no = ?").get(ringNo);
  if (!pigeon) throw new HttpError(404, "pigeon_not_found", "赛鸽不存在");
  const tx = db.transaction(() => {
    db.prepare("UPDATE pigeons SET status = ?, updated_at = datetime('now') WHERE ring_no = ?").run(status, ringNo);
    writeAudit(db, { actor, action: "pigeon.status", entityType: "pigeon", entityId: ringNo, requestId,
      detail: { from: pigeon.status, to: status } });
  });
  tx();
  return { ringNo, status };
}

export function transferPigeon(db, ringNo, { to, loft }, { actor, requestId }) {
  const pigeon = db.prepare("SELECT * FROM pigeons WHERE ring_no = ?").get(ringNo);
  if (!pigeon) throw new HttpError(404, "pigeon_not_found", "赛鸽不存在");
  if (!to && !loft) throw new HttpError(400, "invalid_input", "新鸽主或新棚号至少填一项");
  const tx = db.transaction(() => {
    const date = nowIso().slice(0, 10);
    if (to) {
      db.prepare("INSERT INTO transfers (ring_no, date, from_owner, to_owner) VALUES (?, ?, ?, ?)")
        .run(ringNo, date, pigeon.owner, to);
    }
    db.prepare("UPDATE pigeons SET owner = COALESCE(NULLIF(?, ''), owner), loft_no = COALESCE(NULLIF(?, ''), loft_no), updated_at = datetime('now') WHERE ring_no = ?")
      .run(to || "", loft || "", ringNo);
    writeAudit(db, { actor, action: "pigeon.transfer", entityType: "pigeon", entityId: ringNo, requestId,
      detail: { owner: { from: pigeon.owner, to: to || pigeon.owner }, loft: { from: pigeon.loft_no, to: loft || pigeon.loft_no } } });
  });
  tx();
  return db.prepare("SELECT * FROM pigeons WHERE ring_no = ?").get(ringNo);
}

// ---------- 赛事 ----------
export function listRaces(db) {
  return db.prepare("SELECT * FROM races ORDER BY id DESC").all()
    .map(r => ({ ...r, allowed_lofts: JSON.parse(r.allowed_lofts || "[]") }));
}

export function publishRace(db, input, { actor, requestId }) {
  const name = String(input.name || "").trim();
  const distance = Math.trunc(Number(input.distance));
  const lofts = Array.isArray(input.lofts) ? input.lofts.map(String).filter(Boolean) : [];
  if (!name) throw new HttpError(400, "invalid_input", "赛事名称不能为空");
  if (!distance || distance <= 0) throw new HttpError(400, "invalid_input", "赛事距离必须为正整数（米）");
  if (lofts.length === 0) throw new HttpError(400, "invalid_input", "至少圈定一个参赛棚号");
  let releaseAt = null;
  if (input.releaseAt) releaseAt = parseTime(input.releaseAt, "放飞时间").toISOString();

  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO races (name, release_at, distance_m, allowed_lofts, status, created_by)
      VALUES (?, ?, ?, ?, 'published', ?)`)
      .run(name, releaseAt, distance, JSON.stringify(lofts), actor);
    writeAudit(db, { actor, action: "race.publish", entityType: "race", entityId: info.lastInsertRowid, requestId,
      detail: { name, distance, lofts, releaseAt } });
    return info.lastInsertRowid;
  });
  const id = tx();
  return getRace(db, id);
}

export function selectEntries(db, raceId, body, { actor, requestId }) {
  const race = getRace(db, raceId);
  if (race.status !== "published") deny(db, requestId, actor, "roster.select", "race", raceId,
    "roster_locked", "赛事已放飞或关闭，不能再圈定名单", { status: race.status });

  const lofts = Array.isArray(body.lofts) && body.lofts.length
    ? body.lofts.map(String)
    : race.allowed_lofts;
  const unknown = lofts.filter(l => !race.allowed_lofts.includes(l));
  if (unknown.length) deny(db, requestId, actor, "roster.select", "race", raceId,
    "loft_not_allowed", "棚号不在赛事公布范围内", { unknown });

  const tx = db.transaction(() => {
    const added = [];
    const skipped = [];
    const candidates = db.prepare("SELECT * FROM pigeons WHERE loft_no IN (%s) ORDER BY ring_no"
      .replace("%s", lofts.map(() => "?").join(","))).all(...lofts);
    const exists = db.prepare("SELECT 1 FROM entries WHERE race_id = ? AND ring_no = ?");
    const insert = db.prepare("INSERT INTO entries (race_id, ring_no, loft_no, selected_by) VALUES (?, ?, ?, ?)");
    for (const p of candidates) {
      if (exists.get(raceId, p.ring_no)) continue;
      if (p.status !== "normal") { skipped.push({ ringNo: p.ring_no, reason: "abnormal_status", status: p.status }); continue; }
      insert.run(raceId, p.ring_no, p.loft_no, actor);
      added.push(p.ring_no);
    }
    writeAudit(db, { actor, action: "roster.select", entityType: "race", entityId: raceId, requestId,
      detail: { lofts, addedCount: added.length, added, skipped } });
    return { added, skipped };
  });
  return tx();
}

export function releaseRace(db, raceId, body, { actor, requestId }) {
  const race = getRace(db, raceId);
  if (race.status !== "published") throw new HttpError(409, "race_status", "只有已发布未放飞的赛事可以记录放飞");
  const releaseAt = parseTime(body.releaseAt, "放飞时间");
  const entered = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE race_id = ?").get(raceId).n;
  if (entered === 0) throw new HttpError(409, "roster_empty", "参赛名单为空，不能放飞");
  const tx = db.transaction(() => {
    db.prepare("UPDATE races SET release_at = ?, status = 'released', released_at = datetime('now') WHERE id = ?")
      .run(releaseAt.toISOString(), raceId);
    writeAudit(db, { actor, action: "race.release", entityType: "race", entityId: raceId, requestId,
      detail: { releaseAt: releaseAt.toISOString() } });
  });
  tx();
  return getRace(db, raceId);
}

export function closeRace(db, raceId, { actor, requestId }) {
  const race = getRace(db, raceId);
  if (race.status === "closed") throw new HttpError(409, "race_status", "赛事已关闭");
  const tx = db.transaction(() => {
    db.prepare("UPDATE races SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(raceId);
    writeAudit(db, { actor, action: "race.close", entityType: "race", entityId: raceId, requestId, detail: {} });
  });
  tx();
  return getRace(db, raceId);
}

// 依据放飞时间、距离、实际归巢时间重算全部名次（分速高者列前，同速先到列前）
function rerank(db, raceId, actor, requestId, reason) {
  const race = db.prepare("SELECT * FROM races WHERE id = ?").get(raceId);
  const releaseMs = new Date(race.release_at).getTime();
  const arrivals = db.prepare("SELECT * FROM arrivals WHERE race_id = ?").all(raceId);
  const ranked = arrivals.map(a => {
    const arrivedMs = new Date(a.arrived_at).getTime();
    const minutes = (arrivedMs - releaseMs) / 60000;
    const speed = minutes > 0 ? +(race.distance_m / minutes).toFixed(3) : 0;
    return { id: a.id, ring_no: a.ring_no, arrived_at: a.arrived_at, minutes: +minutes.toFixed(3), speed };
  }).sort((a, b) => (b.speed - a.speed) || (new Date(a.arrived_at) - new Date(b.arrived_at)) || a.ring_no.localeCompare(b.ring_no));
  const update = db.prepare("UPDATE arrivals SET speed_m_per_min = ?, rank = ? WHERE id = ?");
  ranked.forEach((a, i) => { a.rank = i + 1; update.run(a.speed, a.rank, a.id); });
  writeAudit(db, { actor, action: "rank.recompute", entityType: "race", entityId: raceId, requestId,
    detail: { reason, count: ranked.length, ranking: ranked.map((a, idx) => ({ rank: idx + 1, ringNo: a.ring_no })) } });
  return ranked;
}

export function registerArrival(db, raceId, body, ctx) {
  const { actor, requestId, fault = null } = ctx;
  const race = getRace(db, raceId);
  const ringNo = String(body.ringNo || "").trim().toUpperCase();
  if (!ringNo) throw new HttpError(400, "invalid_input", "足环号不能为空");
  const arrivedAt = parseTime(body.arrivedAt, "归巢时间");

  const pigeon = db.prepare("SELECT * FROM pigeons WHERE ring_no = ?").get(ringNo);
  if (!pigeon) deny(db, requestId, actor, "arrival.checkin", "race", raceId, "pigeon_not_found", "赛鸽不存在: " + ringNo, { ringNo });
  if (race.status === "published") deny(db, requestId, actor, "arrival.checkin", "race", raceId,
    "race_not_released", "赛事尚未放飞，不能报到", { ringNo });
  if (race.status === "closed") deny(db, requestId, actor, "arrival.checkin", "race", raceId,
    "race_closed", "赛事已关闭，报到通道已关闭", { ringNo });

  const entry = db.prepare("SELECT * FROM entries WHERE race_id = ? AND ring_no = ?").get(raceId, ringNo);
  if (!entry) deny(db, requestId, actor, "arrival.checkin", "race", raceId,
    "not_entered", `未入选赛鸽不能报到: ${ringNo}`, { ringNo });
  if (entry.loft_no !== pigeon.loft_no) deny(db, requestId, actor, "arrival.checkin", "race", raceId,
    "cross_loft", `跨棚成绩拦截: 入名单棚号 ${entry.loft_no}，现棚号 ${pigeon.loft_no}`,
    { ringNo, rosterLoft: entry.loft_no, currentLoft: pigeon.loft_no });
  if (pigeon.status !== "normal") deny(db, requestId, actor, "arrival.checkin", "race", raceId,
    "abnormal_status", `赛鸽状态异常（${STATUS_TEXT[pigeon.status] || pigeon.status}），成绩拦截: ${ringNo}`,
    { ringNo, status: pigeon.status });
  if (db.prepare("SELECT 1 FROM arrivals WHERE race_id = ? AND ring_no = ?").get(raceId, ringNo)) {
    deny(db, requestId, actor, "arrival.checkin", "race", raceId,
      "duplicate_arrival", `重复报到拦截: ${ringNo} 已有归巢记录`, { ringNo });
  }
  if (arrivedAt.getTime() <= new Date(race.release_at).getTime()) {
    deny(db, requestId, actor, "arrival.checkin", "race", raceId,
      "arrival_before_release", "归巢时间早于放飞时间", { ringNo });
  }

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO arrivals (race_id, ring_no, arrived_at, source, created_by)
      VALUES (?, ?, ?, 'checkin', ?)`).run(raceId, ringNo, arrivedAt.toISOString(), actor);
    // 故障注入：数据行已插入、名次尚未更新时模拟落盘失败，整个事务必须回滚
    if (fault === "arrival-insert") throw new Error("injected storage failure after arrival insert");
    const ranked = rerank(db, raceId, actor, requestId, "checkin:" + ringNo);
    writeAudit(db, { actor, action: "arrival.checkin", entityType: "race", entityId: raceId, requestId,
      detail: { ringNo, arrivedAt: arrivedAt.toISOString() } });
    return ranked;
  });
  const ranked = tx();
  return ranked.find(a => a.ring_no === ringNo);
}

export function adjustArrival(db, raceId, ringNo, body, { actor, requestId }) {
  const race = getRace(db, raceId);
  const arrival = db.prepare("SELECT * FROM arrivals WHERE race_id = ? AND ring_no = ?").get(raceId, ringNo);
  if (!arrival) throw new HttpError(404, "arrival_not_found", "该赛鸽没有归巢记录");
  const newTime = body.arrivedAt ? parseTime(body.arrivedAt, "归巢时间") : null;
  const reason = String(body.reason || "").trim() || "管理员更正";
  if (newTime && newTime.getTime() <= new Date(race.release_at).getTime()) {
    throw new HttpError(422, "arrival_before_release", "更正后的时间早于放飞时间");
  }
  const tx = db.transaction(() => {
    if (newTime) {
      db.prepare("UPDATE arrivals SET arrived_at = ? WHERE id = ?").run(newTime.toISOString(), arrival.id);
      writeAudit(db, { actor, action: "arrival.adjust", entityType: "race", entityId: raceId, requestId,
        detail: { ringNo, from: arrival.arrived_at, to: newTime.toISOString(), reason } });
    } else {
      db.prepare("DELETE FROM arrivals WHERE id = ?").run(arrival.id);
      writeAudit(db, { actor, action: "arrival.void", entityType: "race", entityId: raceId, requestId,
        detail: { ringNo, from: arrival.arrived_at, reason } });
    }
    rerank(db, raceId, actor, requestId, "adjust:" + ringNo);
  });
  tx();
  return raceDetail(db, raceId);
}

export function raceDetail(db, raceId) {
  const race = getRace(db, raceId);
  race.entries = db.prepare(`
    SELECT e.ring_no, e.loft_no AS roster_loft, e.selected_at, p.owner, p.status,
           p.loft_no AS current_loft, a.arrived_at, a.speed_m_per_min, a.rank
    FROM entries e JOIN pigeons p ON p.ring_no = e.ring_no
    LEFT JOIN arrivals a ON a.race_id = e.race_id AND a.ring_no = e.ring_no
    WHERE e.race_id = ? ORDER BY e.ring_no`).all(raceId);
  race.arrivals = db.prepare(`
    SELECT a.ring_no, a.arrived_at, a.speed_m_per_min, a.rank, p.owner, p.loft_no
    FROM arrivals a JOIN pigeons p ON p.ring_no = a.ring_no
    WHERE a.race_id = ? ORDER BY a.rank`).all(raceId);
  race.audit = listAudit(db, { entityType: "race", entityId: raceId });
  return race;
}

export function listAudit(db, { entityType, entityId, limit = 300 } = {}) {
  let sql = "SELECT * FROM audit_logs";
  const where = [];
  const params = [];
  if (entityType) { where.push("entity_type = ?"); params.push(entityType); }
  if (entityId) { where.push("entity_id = ?"); params.push(String(entityId)); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY id DESC LIMIT " + Number(limit);
  return db.prepare(sql).all(...params).map(r => ({ ...r, detail: JSON.parse(r.detail || "{}") }));
}

export { STATUS_TEXT };
