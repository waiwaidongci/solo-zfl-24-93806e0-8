import { DomainError } from "./store.js";

/**
 * 赛事运营领域逻辑。
 * 所有 mutator 运行在 store 的串行事务里，操作 draft；拦截类失败抛 DomainError，
 * 由 store 保证「要么全成（含审计落盘），要么内存和文件都不变」。
 */

export const AUDIT_ACTIONS = [
  "race_publish",
  "entries_select",
  "entries_add",
  "entries_remove",
  "race_release",
  "checkin",
  "checkin_rejected",
  "rank_recompute",
  "checkin_adjust",
  "checkin_delete",
  "race_close",
  "pigeon_status",
];

function iso(d) {
  return d.toISOString();
}

export function audit(draft, h, action, target, detail, result = "ok") {
  draft.audit.entries.push({
    id: h.nextId(),
    at: iso(h.now()),
    action,
    target: target || "",
    result, // ok | rejected | failed
    detail,
  });
}

export function findRace(draft, raceId) {
  const race = draft.races.races.find((r) => r.id === raceId);
  if (!race) throw new DomainError("race_not_found", "赛事不存在");
  return race;
}

export function findPigeon(draft, ringNo) {
  return draft.pigeons.pigeons.find((p) => p.ringNo === ringNo) || null;
}

// ---------- 分速与名次 ----------

/** 分速（米/分）= 距离(公里) * 1000 / 用时(分钟)，保留两位小数 */
export function speedMps(distanceKm, elapsedMs) {
  const minutes = elapsedMs / 60000;
  return Math.round(((distanceKm * 1000) / minutes) * 100) / 100;
}

export function recomputeRankings(race) {
  for (const c of race.checkins) {
    const elapsed = new Date(c.arriveAt).getTime() - new Date(race.releaseAt).getTime();
    c.elapsedMs = elapsed;
    c.speed = elapsed > 0 ? speedMps(race.distance, elapsed) : 0;
  }
  // 分速高者列前；同速先到列前；再按环号稳定排序
  race.checkins.sort((a, b) => {
    if (b.speed !== a.speed) return b.speed - a.speed;
    if (a.arriveAt !== b.arriveAt) return a.arriveAt < b.arriveAt ? -1 : 1;
    return a.ringNo < b.ringNo ? -1 : 1;
  });
  let prevSpeed = null;
  let lastRank = 0;
  race.checkins.forEach((c, i) => {
    // 并列分速同名次，下一名次顺延
    if (prevSpeed !== null && c.speed === prevSpeed) c.rank = lastRank;
    else { c.rank = i + 1; lastRank = i + 1; prevSpeed = c.speed; }
  });
}

// ---------- 赛事 ----------

export function createRace(draft, h, input) {
  const name = String(input.name || "").trim();
  if (!name) throw new DomainError("race_name_required", "赛事名称不能为空");
  const distance = Number(input.distance);
  if (!Number.isFinite(distance) || distance <= 0) throw new DomainError("distance_invalid", "赛事距离必须为正数");
  const id = `R${String(h.nextId()).padStart(4, "0")}`;
  const race = {
    id,
    name,
    distance,
    releasePoint: String(input.releasePoint || "").trim(),
    releaseAt: null,
    status: "draft", // draft | released | closed
    entries: [],    // { ringNo, loft, source: 'loft'|'manual', addedAt }
    checkins: [],
    createdAt: iso(h.now()),
  };
  draft.races.races.push(race);
  audit(draft, h, "race_publish", id, { name, distance, releasePoint: race.releasePoint });
  return race;
}

function assertEditable(race) {
  if (race.status !== "draft") throw new DomainError("race_locked", "赛事已放飞或关闭，名单不可修改");
}

/** 按棚号圈定：以选中棚号整体重选（手工增补保留），状态异常鸽不入选 */
export function selectEntries(draft, h, raceId, input) {
  const race = findRace(draft, raceId);
  assertEditable(race);
  const lofts = (Array.isArray(input.lofts) ? input.lofts : [])
    .map((x) => String(x).trim()).filter(Boolean);
  if (!lofts.length) throw new DomainError("lofts_required", "至少选择一个棚号");

  const manual = race.entries.filter((e) => e.source === "manual");
  const picked = new Map();
  const skippedAbnormal = [];
  for (const p of draft.pigeons.pigeons) {
    if (lofts.includes(p.loft)) {
      if (p.status && p.status !== "正常") { skippedAbnormal.push(p.ringNo); continue; }
      picked.set(p.ringNo, { ringNo: p.ringNo, loft: p.loft, source: "loft", addedAt: iso(h.now()) });
    }
  }
  for (const e of manual) if (!picked.has(e.ringNo)) picked.set(e.ringNo, e);
  const before = race.entries.map((e) => e.ringNo).sort();
  race.entries = [...picked.values()];
  const after = race.entries.map((e) => e.ringNo).sort();
  audit(draft, h, "entries_select", raceId, {
    lofts, count: race.entries.length, skippedAbnormal,
    added: after.filter((r) => !before.includes(r)),
    removed: before.filter((r) => !after.includes(r)),
  });
  return race;
}

export function addEntry(draft, h, raceId, input) {
  const race = findRace(draft, raceId);
  assertEditable(race);
  const ringNo = String(input.ringNo || "").trim();
  const pigeon = findPigeon(draft, ringNo);
  if (!pigeon) throw new DomainError("pigeon_not_found", "赛鸽未登记");
  if (race.entries.some((e) => e.ringNo === ringNo)) throw new DomainError("entry_exists", "该鸽已在参赛名单中");
  if (pigeon.status && pigeon.status !== "正常") throw new DomainError("pigeon_abnormal", `赛鸽状态为「${pigeon.status}」，不能入选`);
  race.entries.push({ ringNo, loft: pigeon.loft, source: "manual", addedAt: iso(h.now()) });
  audit(draft, h, "entries_add", raceId, { ringNo, loft: pigeon.loft });
  return race;
}

export function removeEntry(draft, h, raceId, ringNo) {
  const race = findRace(draft, raceId);
  assertEditable(race);
  const idx = race.entries.findIndex((e) => e.ringNo === ringNo);
  if (idx < 0) throw new DomainError("entry_not_found", "该鸽不在参赛名单中");
  const [entry] = race.entries.splice(idx, 1);
  audit(draft, h, "entries_remove", raceId, { ringNo: entry.ringNo, loft: entry.loft });
  return race;
}

export function releaseRace(draft, h, raceId, input) {
  const race = findRace(draft, raceId);
  if (race.status !== "draft") throw new DomainError("race_already_released", "赛事已记录放飞时间");
  if (!race.entries.length) throw new DomainError("entries_empty", "参赛名单为空，不能放飞");
  const releaseAt = new Date(input.releaseAt);
  if (isNaN(releaseAt.getTime())) throw new DomainError("release_time_invalid", "放飞时间格式不正确");
  race.releaseAt = releaseAt.toISOString();
  race.status = "released";
  audit(draft, h, "race_release", raceId, { releaseAt: race.releaseAt, entries: race.entries.length });
  return race;
}

export class CheckinRejected extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "CheckinRejected";
    this.reason = reason;
    this.detail = detail;
  }
}

// ---------- 归巢报到 ----------

export function checkin(draft, h, raceId, input) {
  const race = findRace(draft, raceId);
  const ringNo = String(input.ringNo || "").trim();
  const arriveRaw = String(input.arriveAt || "").trim();
  const arriveAt = new Date(arriveRaw);

  // 拦截：抛 CheckinRejected 使本事务（报到数据）回滚；
  // 由 HTTP 层在独立事务里补写 checkin_rejected 审计，确保「数据不进、审计留痕」。
  const reject = (reason, detail = {}) => {
    throw new CheckinRejected(reason, { ringNo, arriveAt: arriveRaw, ...detail });
  };

  if (race.status !== "released") reject("race_not_released");
  if (isNaN(arriveAt.getTime())) reject("arrive_time_invalid");
  if (arriveAt.getTime() < new Date(race.releaseAt).getTime()) reject("arrive_before_release");

  const pigeon = findPigeon(draft, ringNo);
  if (!pigeon) reject("pigeon_not_found");
  const entry = race.entries.find((e) => e.ringNo === ringNo);
  if (!entry) {
    // 未入选 / 跨棚：未入选直接拦；带 loft 参数且与登记棚不符为跨棚
    if (input.loft && String(input.loft).trim() !== pigeon.loft) {
      reject("cross_loft_result", { reportedLoft: String(input.loft).trim(), registeredLoft: pigeon.loft });
    }
    reject("pigeon_not_in_entries");
  }
  if (pigeon.status && pigeon.status !== "正常") reject("pigeon_abnormal", { status: pigeon.status });
  if (race.checkins.some((c) => c.ringNo === ringNo)) reject("duplicate_checkin");
  if (input.loft && String(input.loft).trim() !== pigeon.loft) {
    reject("cross_loft_result", { reportedLoft: String(input.loft).trim(), registeredLoft: pigeon.loft });
  }

  const record = {
    ringNo,
    loft: pigeon.loft,
    arriveAt: arriveAt.toISOString(),
    elapsedMs: 0,
    speed: 0,
    rank: 0,
    reportedAt: iso(h.now()),
  };
  race.checkins.push(record);
  recomputeRankings(race);
  audit(draft, h, "checkin", raceId, {
    ringNo, arriveAt: record.arriveAt, speed: record.speed, rank: record.rank,
  });
  return { race, record };
}

/** 拦截留痕：报到事务回滚后，在独立事务里写 rejected 审计（自身原子落盘） */
export function logRejectedCheckin(draft, h, raceId, reason, detail) {
  findRace(draft, raceId);
  audit(draft, h, "checkin_rejected", raceId, { reason, ...detail }, "rejected");
  return true;
}

// ---------- 调整 ----------
export function adjustCheckin(draft, h, raceId, ringNo, input) {
  const race = findRace(draft, raceId);
  const record = race.checkins.find((c) => c.ringNo === ringNo);
  if (!record) throw new DomainError("checkin_not_found", "没有该鸽的报到记录");
  const arriveAt = new Date(input.arriveAt);
  if (isNaN(arriveAt.getTime())) throw new DomainError("arrive_time_invalid", "归巢时间格式不正确");
  if (race.releaseAt && arriveAt.getTime() < new Date(race.releaseAt).getTime()) {
    throw new DomainError("arrive_before_release", "归巢时间早于放飞时间");
  }
  const before = { arriveAt: record.arriveAt, rank: record.rank, speed: record.speed };
  record.arriveAt = arriveAt.toISOString();
  recomputeRankings(race);
  audit(draft, h, "checkin_adjust", raceId, {
    ringNo, before, after: { arriveAt: record.arriveAt, rank: record.rank, speed: record.speed },
    reason: String(input.reason || "").trim(),
  });
  return race;
}

export function deleteCheckin(draft, h, raceId, ringNo, input) {
  const race = findRace(draft, raceId);
  const idx = race.checkins.findIndex((c) => c.ringNo === ringNo);
  if (idx < 0) throw new DomainError("checkin_not_found", "没有该鸽的报到记录");
  const [removed] = race.checkins.splice(idx, 1);
  recomputeRankings(race);
  audit(draft, h, "checkin_delete", raceId, { ringNo, removed: { arriveAt: removed.arriveAt, rank: removed.rank }, reason: String(input?.reason || "").trim() });
  return race;
}

export function closeRace(draft, h, raceId) {
  const race = findRace(draft, raceId);
  if (race.status === "closed") throw new DomainError("race_already_closed", "赛事已关闭");
  race.status = "closed";
  audit(draft, h, "race_close", raceId, { checkins: race.checkins.length });
  return race;
}

export function setPigeonStatus(draft, h, ringNo, status, reason) {
  const pigeon = findPigeon(draft, ringNo);
  if (!pigeon) throw new DomainError("pigeon_not_found", "赛鸽未登记");
  if (!["正常", "异常", "失格", "伤病"].includes(status)) throw new DomainError("status_invalid", "状态值不合法");
  const before = pigeon.status || "正常";
  pigeon.status = status;
  audit(draft, h, "pigeon_status", ringNo, { before, after: status, reason: String(reason || "").trim() });
  return pigeon;
}
