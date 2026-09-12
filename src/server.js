import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, DomainError } from "./store.js";
import {
  createRace, selectEntries, addEntry, removeEntry, releaseRace,
  checkin, logRejectedCheckin, CheckinRejected, adjustCheckin, deleteCheckin,
  closeRace, setPigeonStatus,
} from "./races.js";
import { isLegacyPath, handleLegacy } from "./legacy.js";
import { renderApp } from "./app-page.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const dataDir = process.env.DATA_DIR || join(rootDir, "data");
const port = Number(process.env.PORT || 3024);

const seedPigeons = JSON.parse(
  await readFile(join(dataDir, "pigeons.json"), "utf8").catch(() => '{"pigeons":[]}')
);

export const store = createStore({ dataDir, seedPigeons });
await store.init();

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new DomainError("bad_json", "请求体不是合法 JSON"); }
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** 执行领域事务：fn 返回业务值，files 声明需要落盘的文件（含审计） */
async function runTx(fn, files) {
  let value;
  await store.tx(async (d, h) => {
    value = await fn(d, h);
    return files;
  });
  return value;
}

const STATUS_400 = new Set([
  "race_name_required", "distance_invalid", "lofts_required", "race_locked",
  "entry_exists", "entry_not_found", "race_already_released", "entries_empty",
  "release_time_invalid", "race_not_released", "arrive_time_invalid",
  "arrive_before_release", "cross_loft_result", "duplicate_checkin",
  "pigeon_not_in_entries", "pigeon_abnormal", "pigeon_not_found",
  "checkin_not_found", "status_invalid", "race_already_closed",
  "ring_exists", "to_required", "bad_json",
]);

async function handleApi(req, res, url) {
  const p = url.pathname;
  const body = req.method !== "GET" && req.method !== "HEAD" ? await readBody(req) : {};

  // 赛鸽名册
  if (p === "/api/pigeons" && req.method === "GET") {
    const d = await store.read();
    return sendJson(res, 200, d.pigeons.pigeons);
  }
  const statusMatch = p.match(/^\/api\/pigeons\/(.+)\/status$/);
  if (statusMatch && req.method === "POST") {
    const pigeon = await runTx(
      (d, h) => setPigeonStatus(d, h, decodeURIComponent(statusMatch[1]), body.status, body.reason),
      ["pigeons", "audit"]);
    return sendJson(res, 200, pigeon);
  }

  // 赛事
  if (p === "/api/races" && req.method === "GET") {
    const d = await store.read();
    return sendJson(res, 200, d.races.races);
  }
  if (p === "/api/races" && req.method === "POST") {
    const race = await runTx((d, h) => createRace(d, h, body), ["races", "audit"]);
    return sendJson(res, 201, race);
  }
  const raceMatch = p.match(/^\/api\/races\/([^/]+)$/);
  if (raceMatch && req.method === "GET") {
    const d = await store.read();
    const race = d.races.races.find((r) => r.id === raceMatch[1]);
    if (!race) return sendJson(res, 404, { error: "race_not_found" });
    return sendJson(res, 200, race);
  }

  const id = raceMatch ? raceMatch[1] : null;
  if (p.match(/^\/api\/races\/[^/]+\/entries\/select$/) && req.method === "POST") {
    const race = await runTx((d, h) => selectEntries(d, h, idFrom(p), body), ["races", "audit"]);
    return sendJson(res, 200, race);
  }
  if (p.match(/^\/api\/races\/[^/]+\/entries$/) && req.method === "POST") {
    const race = await runTx((d, h) => addEntry(d, h, idFrom(p), body), ["races", "audit"]);
    return sendJson(res, 200, race);
  }
  const entryOne = p.match(/^\/api\/races\/([^/]+)\/entries\/(.+)$/);
  if (entryOne && req.method === "DELETE") {
    const race = await runTx((d, h) => removeEntry(d, h, entryOne[1], decodeURIComponent(entryOne[2])), ["races", "audit"]);
    return sendJson(res, 200, race);
  }
  if (p.match(/^\/api\/races\/[^/]+\/release$/) && req.method === "POST") {
    const race = await runTx((d, h) => releaseRace(d, h, idFrom(p), body), ["races", "audit"]);
    return sendJson(res, 200, race);
  }
  if (p.match(/^\/api\/races\/[^/]+\/checkins$/) && req.method === "POST") {
    const raceId = idFrom(p);
    try {
      const result = await runTx((d, h) => checkin(d, h, raceId, body), ["races", "audit"]);
      return sendJson(res, 201, result.record);
    } catch (error) {
      if (error instanceof CheckinRejected) {
        // 报到数据已随失败事务回滚；拦截审计在独立事务里落盘
        await store.tx((d, h) => {
          logRejectedCheckin(d, h, raceId, error.reason, error.detail);
          return ["audit"];
        });
        return sendJson(res, 400, { error: error.reason, detail: error.detail });
      }
      throw error;
    }
  }
  const checkinOne = p.match(/^\/api\/races\/([^/]+)\/checkins\/(.+)$/);
  if (checkinOne && req.method === "PUT") {
    const race = await runTx((d, h) => adjustCheckin(d, h, checkinOne[1], decodeURIComponent(checkinOne[2]), body), ["races", "audit"]);
    return sendJson(res, 200, race);
  }
  if (checkinOne && req.method === "DELETE") {
    const race = await runTx((d, h) => deleteCheckin(d, h, checkinOne[1], decodeURIComponent(checkinOne[2]), body), ["races", "audit"]);
    return sendJson(res, 200, race);
  }
  if (p.match(/^\/api\/races\/[^/]+\/close$/) && req.method === "POST") {
    const race = await runTx((d, h) => closeRace(d, h, idFrom(p)), ["races", "audit"]);
    return sendJson(res, 200, race);
  }

  // 审计
  if (p === "/api/audit" && req.method === "GET") {
    const d = await store.read();
    let entries = d.audit.entries;
    if (url.searchParams.get("target")) {
      const t = url.searchParams.get("target");
      entries = entries.filter((e) => e.target === t);
    }
    if (url.searchParams.get("action")) {
      entries = entries.filter((e) => e.action === url.searchParams.get("action"));
    }
    return sendJson(res, 200, entries.slice().reverse());
  }

  // 测试辅助：故障注入（仅 FAILPOINT=1 时可用）
  if (p === "/api/test/fail-next-write" && req.method === "POST" && process.env.FAILPOINT === "1") {
    store.failWritesFor(Number(body.count || 1));
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "not_found" });
}

function idFrom(p) {
  return p.split("/")[3];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(renderApp());
    }
    if (isLegacyPath(url.pathname)) {
      const handled = await handleLegacy(req, res, url, store, sendJson, readBody);
      if (handled) return;
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof DomainError) {
      const status = STATUS_400.has(error.code) ? 400 : 400;
      return sendJson(res, error.code === "race_not_found" ? 404 : status, { error: error.code, message: error.message });
    }
    sendJson(res, 500, { error: "internal_error", message: error.message });
  }
});

function start() {
  return new Promise((resolve) => server.listen(port, () => {
    console.log(`赛鸽公棚赛事运营系统: http://localhost:${port}  (旧档案: /legacy)`);
    resolve(server);
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) start();

export { start };
