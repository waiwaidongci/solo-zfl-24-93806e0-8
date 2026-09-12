/**
 * 赛事运营业务逻辑。全部为纯函数:接收 db,校验通过后原地修改并写审计;
 * 校验失败抛 HttpError,由 Store.mutate 负责回滚,保证不留半笔记录。
 */

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const RACE_STATUS = ["draft", "published", "released", "closed"];

const now = () => new Date().toISOString();

function audit(db, entry) {
  db.meta.auditSeq += 1;
  db.audit.push({ seq: db.meta.auditSeq, ts: now(), ...entry });
}

function findRace(db, raceId) {
  const race = db.races.find(item => item.id === raceId);
  if (!race) throw new HttpError(404, "race_not_found", `赛事 ${raceId} 不存在`);
  return race;
}

function findPigeon(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) throw new HttpError(404, "pigeon_not_found", `足环号 ${ringNo} 未登记`);
  return pigeon;
}

function requireStatus(race, allowed, action) {
  if (!allowed.includes(race.status)) {
    throw new HttpError(
      409,
      "invalid_status",
      `赛事当前状态为 ${race.status},不能执行 ${action}(要求 ${allowed.join("/")})`
    );
  }
}

function parseTime(value, field) {
  const ts = Date.parse(value);
  if (!value || Number.isNaN(ts)) throw new HttpError(400, "invalid_time", `${field} 不是合法时间: ${value}`);
  return ts;
}

/** 按有效报到重排名次:分速高者在前,同分速先到者在前。 */
function recomputeRanks(race) {
  const valid = race.checkins
    .filter(item => item.status === "valid")
    .sort((a, b) => b.speed - a.speed || Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime));
  valid.forEach((item, index) => { item.rank = index + 1; });
  return valid;
}

/** 创建赛事(草稿),并按棚号自动圈定参赛名单。 */
export function createRace(db, { name, distanceKm, lofts, actor = "admin" }) {
  if (!name || !String(name).trim()) throw new HttpError(400, "invalid_input", "赛事名称不能为空");
  const distance = Number(distanceKm);
  if (!Number.isFinite(distance) || distance <= 0) throw new HttpError(400, "invalid_input", "赛事距离必须为正数");
  if (!Array.isArray(lofts) || lofts.length === 0) throw new HttpError(400, "invalid_input", "至少圈定一个棚号");
  const knownLofts = new Set(db.pigeons.map(p => p.loft));
  const unknown = lofts.filter(loft => !knownLofts.has(loft));
  if (unknown.length) throw new HttpError(400, "unknown_loft", `棚号未登记: ${unknown.join("、")}`);

  const loftSet = new Set(lofts);
  const roster = db.pigeons.filter(p => loftSet.has(p.loft)).map(p => p.ringNo).sort();
  db.meta.raceSeq += 1;
  const race = {
    id: `R-${String(db.meta.raceSeq).padStart(4, "0")}`,
    name: String(name).trim(),
    distanceKm: distance,
    lofts: [...lofts].sort(),
    roster,
    status: "draft",
    releaseTime: null,
    createdAt: now(),
    publishedAt: null,
    closedAt: null,
    checkins: []
  };
  db.races.push(race);
  audit(db, { actor, action: "race.create", raceId: race.id, detail: `创建赛事「${race.name}」,距离 ${distance} 公里,棚号 ${race.lofts.join("、")}` });
  audit(db, { actor, action: "roster.set", raceId: race.id, detail: `按棚号圈定参赛名单 ${roster.length} 羽: ${roster.join("、") || "无"}` });
  return race;
}

/** 草稿期调整名单(增/删足环号)。 */
export function adjustRoster(db, raceId, { add = [], remove = [], actor = "admin" }) {
  const race = findRace(db, raceId);
  requireStatus(race, ["draft"], "调整名单");
  for (const ringNo of add) findPigeon(db, ringNo);
  const before = new Set(race.roster);
  for (const ringNo of remove) before.delete(ringNo);
  for (const ringNo of add) before.add(ringNo);
  race.roster = [...before].sort();
  audit(db, {
    actor, action: "roster.adjust", raceId: race.id,
    detail: `调整名单: 移除 [${remove.join("、") || "无"}] 加入 [${add.join("、") || "无"}],现有 ${race.roster.length} 羽`
  });
  return race;
}

/** 发布赛事:名单锁定,进入待放飞状态。 */
export function publishRace(db, raceId, { actor = "admin" } = {}) {
  const race = findRace(db, raceId);
  requireStatus(race, ["draft"], "发布赛事");
  if (race.roster.length === 0) throw new HttpError(409, "empty_roster", "参赛名单为空,不能发布");
  race.status = "published";
  race.publishedAt = now();
  audit(db, { actor, action: "race.publish", raceId: race.id, detail: `发布赛事,锁定名单 ${race.roster.length} 羽` });
  return race;
}

/** 记录放飞时间,赛事进入可报到状态。 */
export function releaseRace(db, raceId, { releaseTime, actor = "admin" } = {}) {
  const race = findRace(db, raceId);
  requireStatus(race, ["published"], "记录放飞时间");
  const ts = parseTime(releaseTime, "放飞时间");
  race.releaseTime = new Date(ts).toISOString();
  race.status = "released";
  audit(db, { actor, action: "race.release", raceId: race.id, detail: `放飞时间 ${race.releaseTime}` });
  return race;
}

/**
 * 归巢报到。拦截规则:
 * - 状态异常:赛事未处于已放飞状态
 * - 未入选:足环号不在参赛名单
 * - 跨棚:报到棚号与档案登记棚号不一致,或该棚不在赛事圈定范围
 * - 重复报到:同一足环号已有有效报到
 * - 时间异常:归巢时间不晚于放飞时间
 */
export function checkin(db, raceId, { ringNo, loft, arrivalTime, actor = "admin" }) {
  const race = findRace(db, raceId);
  requireStatus(race, ["released"], "归巢报到");
  const pigeon = findPigeon(db, ringNo);
  if (!race.roster.includes(ringNo)) {
    throw new HttpError(403, "not_in_roster", `足环号 ${ringNo} 未入选本场赛事`);
  }
  if (loft !== pigeon.loft) {
    throw new HttpError(409, "cross_loft", `报到棚号 ${loft} 与档案棚号 ${pigeon.loft} 不一致,疑似跨棚成绩`);
  }
  if (!race.lofts.includes(pigeon.loft)) {
    throw new HttpError(409, "cross_loft", `棚号 ${pigeon.loft} 不在本场赛事圈定范围(${race.lofts.join("、")})`);
  }
  if (race.checkins.some(item => item.ringNo === ringNo && item.status === "valid")) {
    throw new HttpError(409, "duplicate_checkin", `足环号 ${ringNo} 已报到,拒绝重复报到`);
  }
  const arrival = parseTime(arrivalTime, "归巢时间");
  const release = Date.parse(race.releaseTime);
  if (arrival <= release) {
    throw new HttpError(409, "invalid_time", `归巢时间 ${new Date(arrival).toISOString()} 不晚于放飞时间 ${race.releaseTime}`);
  }

  const elapsedMin = (arrival - release) / 60000;
  const speed = Math.round((race.distanceKm * 1000 / elapsedMin) * 10000) / 10000;
  const entry = {
    ringNo,
    loft,
    arrivalTime: new Date(arrival).toISOString(),
    elapsedMin: Math.round(elapsedMin * 1000) / 1000,
    speed,
    rank: null,
    status: "valid",
    voidReason: null,
    recordedAt: now()
  };
  race.checkins.push(entry);
  recomputeRanks(race);
  audit(db, {
    actor, action: "checkin.record", raceId: race.id, ringNo,
    detail: `归巢报到: ${ringNo}(${loft})归巢 ${entry.arrivalTime},用时 ${entry.elapsedMin} 分钟,分速 ${speed},暂列第 ${entry.rank} 名`
  });
  return { race, entry };
}

/** 作废一笔报到(调整动作),并重排名次。 */
export function voidCheckin(db, raceId, ringNo, { reason, actor = "admin" } = {}) {
  const race = findRace(db, raceId);
  requireStatus(race, ["released"], "作废报到");
  const entry = race.checkins.find(item => item.ringNo === ringNo && item.status === "valid");
  if (!entry) throw new HttpError(404, "checkin_not_found", `足环号 ${ringNo} 没有有效报到记录`);
  entry.status = "void";
  entry.voidReason = reason || "未说明原因";
  entry.rank = null;
  recomputeRanks(race);
  audit(db, { actor, action: "checkin.void", raceId: race.id, ringNo, detail: `作废 ${ringNo} 的报到,原因: ${entry.voidReason};名次已重排` });
  return race;
}

/** 封存赛事:名次定稿,不再接受报到与调整。 */
export function closeRace(db, raceId, { actor = "admin" } = {}) {
  const race = findRace(db, raceId);
  requireStatus(race, ["released"], "封存赛事");
  race.status = "closed";
  race.closedAt = now();
  const board = recomputeRanks(race);
  audit(db, {
    actor, action: "race.close", raceId: race.id,
    detail: `封存赛事,有效报到 ${board.length} 羽,冠军 ${board[0] ? `${board[0].ringNo}(分速 ${board[0].speed})` : "无"}`
  });
  return race;
}

export function getRace(db, raceId) {
  return findRace(db, raceId);
}

export function listRaces(db) {
  return db.races;
}

export function listAudit(db, { raceId } = {}) {
  return raceId ? db.audit.filter(item => item.raceId === raceId) : db.audit;
}

export function listLofts(db) {
  return [...new Set(db.pigeons.map(p => p.loft))].sort();
}
