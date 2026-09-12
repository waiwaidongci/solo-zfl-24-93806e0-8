import http from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { opsPage } from "./pages/ops.js";
import { legacyPage } from "./pages/legacy.js";
import * as svc from "./services.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, "..", "data");
const dbPath = join(dataDir, "racing.db");
const legacyJsonPath = join(dataDir, "pigeons.json");
const port = Number(process.env.PORT || 3024);
const db = openDb(dbPath, { legacyJsonPath });

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new svc.HttpError(400, "invalid_json", "请求体不是合法 JSON"); }
}

// 旧档案入口的接口（行为与旧站保持一致，同时写入审计）
function legacyRoutes(req, res, url, body, ctx) {
  const sendPigeon = (p) => sendJson(res, 200, {
    ringNo: p.ring_no, owner: p.owner, fatherRing: p.father_ring, motherRing: p.mother_ring,
    color: p.color, loft: p.loft_no, status: p.status,
    vaccines: db.prepare("SELECT date, name FROM vaccines WHERE ring_no = ? ORDER BY id").all(p.ring_no),
    transfers: db.prepare("SELECT date, from_owner AS \"from\", to_owner AS \"to\" FROM transfers WHERE ring_no = ? ORDER BY id").all(p.ring_no),
    races: db.prepare("SELECT date, event, distance, return_time AS returnTime, rank FROM pigeon_race_legacy WHERE ring_no = ? ORDER BY id").all(p.ring_no)
  });

  if (req.method === "GET" && url.pathname === "/legacy/api/pigeons") {
    return sendJson(res, 200, db.prepare("SELECT ring_no AS ringNo, owner, father_ring AS fatherRing, mother_ring AS motherRing, color, loft_no AS loft, status FROM pigeons ORDER BY ring_no").all());
  }
  if (req.method === "POST" && url.pathname === "/legacy/api/pigeons") {
    const ringNo = String(body.ringNo || "").trim();
    if (!ringNo || !body.owner || !body.loft) throw new svc.HttpError(400, "invalid_input", "足环号、鸽主、棚号必填");
    if (db.prepare("SELECT 1 FROM pigeons WHERE ring_no = ?").get(ringNo)) return sendJson(res, 409, { error: "ring_exists" });
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO pigeons (ring_no, owner, father_ring, mother_ring, color, loft_no, status, legacy)
        VALUES (?, ?, ?, ?, ?, ?, 'normal', 1)`)
        .run(ringNo, body.owner, body.fatherRing || "", body.motherRing || "", body.color || "", body.loft);
      svc.writeAudit(db, { ...ctx, action: "legacy.pigeon.create", entityType: "pigeon", entityId: ringNo, detail: { via: "legacy_archive" } });
    });
    tx();
    return sendPigeon(db.prepare("SELECT * FROM pigeons WHERE ring_no = ?").get(ringNo));
  }
  const relationMatch = url.pathname.match(/^\/legacy\/api\/pigeons\/(.+)\/relation$/);
  if (relationMatch && req.method === "GET") {
    const ringNo = decodeURIComponent(relationMatch[1]);
    const pigeon = db.prepare("SELECT * FROM pigeons WHERE ring_no = ?").get(ringNo);
    if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
    const find = (r) => db.prepare("SELECT ring_no AS ringNo, owner, color FROM pigeons WHERE ring_no = ?").get(r) || null;
    return sendJson(res, 200, {
      pigeon: {
        ringNo: pigeon.ring_no, owner: pigeon.owner, color: pigeon.color, loft: pigeon.loft_no, status: pigeon.status,
        transfers: db.prepare("SELECT date, from_owner AS \"from\", to_owner AS \"to\" FROM transfers WHERE ring_no = ?").all(ringNo),
        races: db.prepare("SELECT date, event, distance, return_time AS returnTime, rank FROM pigeon_race_legacy WHERE ring_no = ?").all(ringNo)
      },
      father: find(pigeon.father_ring),
      mother: find(pigeon.mother_ring),
      children: db.prepare("SELECT ring_no AS ringNo, owner, color FROM pigeons WHERE father_ring = ? OR mother_ring = ?").all(ringNo, ringNo)
    });
  }
  const actionMatch = url.pathname.match(/^\/legacy\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
  if (actionMatch && req.method === "POST") {
    const ringNo = decodeURIComponent(actionMatch[1]);
    const pigeon = db.prepare("SELECT * FROM pigeons WHERE ring_no = ?").get(ringNo);
    if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
    const kind = actionMatch[2];
    const date = body.date || new Date().toISOString().slice(0, 10);
    const tx = db.transaction(() => {
      if (kind === "transfers") {
        const to = String(body.to || "").trim();
        if (!to) throw new svc.HttpError(400, "invalid_input", "新归属人不能为空");
        db.prepare("INSERT INTO transfers (ring_no, date, from_owner, to_owner) VALUES (?, ?, ?, ?)").run(ringNo, date, pigeon.owner, to);
        if (body.loft) db.prepare("UPDATE pigeons SET owner = ?, loft_no = ? WHERE ring_no = ?").run(to, String(body.loft), ringNo);
        else db.prepare("UPDATE pigeons SET owner = ? WHERE ring_no = ?").run(to, ringNo);
        svc.writeAudit(db, { ...ctx, action: "legacy.transfer", entityType: "pigeon", entityId: ringNo, detail: { from: pigeon.owner, to, loft: body.loft || null, via: "legacy_archive" } });
      }
      if (kind === "races") {
        db.prepare("INSERT INTO pigeon_race_legacy (ring_no, date, event, distance, return_time, rank) VALUES (?, ?, ?, ?, ?, ?)")
          .run(ringNo, date, body.event || "未命名赛事", Number(body.distance || 0), body.returnTime || "", Number(body.rank || 0));
        svc.writeAudit(db, { ...ctx, action: "legacy.race_record", entityType: "pigeon", entityId: ringNo, detail: { event: body.event, via: "legacy_archive" } });
      }
      if (kind === "vaccines") {
        db.prepare("INSERT INTO vaccines (ring_no, date, name) VALUES (?, ?, ?)").run(ringNo, date, body.name || "");
        svc.writeAudit(db, { ...ctx, action: "legacy.vaccine", entityType: "pigeon", entityId: ringNo, detail: { name: body.name, via: "legacy_archive" } });
      }
    });
    tx();
    return sendPigeon(db.prepare("SELECT * FROM pigeons WHERE ring_no = ?").get(ringNo));
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const requestId = req.headers["x-request-id"] || randomUUID();
  const ctx = { requestId, actor: req.headers["x-actor"] || "admin" };
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(opsPage);
    }
    if (req.method === "GET" && url.pathname === "/legacy") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(legacyPage);
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true, pigeons: db.prepare("SELECT COUNT(*) AS n FROM pigeons").get().n });
    }

    const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : {};

    if (url.pathname.startsWith("/legacy/")) {
      const handled = legacyRoutes(req, res, url, body, ctx);
      if (handled !== null) return;
      return sendJson(res, 404, { error: "not_found" });
    }

    // ---- 运营 API ----
    const m = url.pathname.match(/^\/api\/races(?:\/(\d+))?(?:\/(.+))?$/);
    if (url.pathname === "/api/pigeons" && req.method === "GET") {
      return sendJson(res, 200, svc.listPigeons(db));
    }
    const statusMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/status$/);
    if (statusMatch && req.method === "POST") {
      return sendJson(res, 200, svc.setPigeonStatus(db, decodeURIComponent(statusMatch[1]), body.status, ctx));
    }
    const transferMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/transfer$/);
    if (transferMatch && req.method === "POST") {
      return sendJson(res, 200, svc.transferPigeon(db, decodeURIComponent(transferMatch[1]), body, ctx));
    }
    if (url.pathname === "/api/races" && req.method === "GET") {
      return sendJson(res, 200, svc.listRaces(db));
    }
    if (url.pathname === "/api/races" && req.method === "POST") {
      return sendJson(res, 201, svc.publishRace(db, body, ctx));
    }
    if (url.pathname === "/api/audit" && req.method === "GET") {
      return sendJson(res, 200, svc.listAudit(db, {
        entityType: url.searchParams.get("entityType") || undefined,
        entityId: url.searchParams.get("entityId") || undefined,
        limit: Number(url.searchParams.get("limit") || 300)
      }));
    }
    if (m && m[1]) {
      const raceId = Number(m[1]);
      const sub = m[2] || "";
      if (!sub && req.method === "GET") return sendJson(res, 200, svc.raceDetail(db, raceId));
      if (sub === "roster" && req.method === "POST") return sendJson(res, 200, svc.selectEntries(db, raceId, body, ctx));
      if (sub === "release" && req.method === "POST") return sendJson(res, 200, svc.releaseRace(db, raceId, body, ctx));
      if (sub === "close" && req.method === "POST") return sendJson(res, 200, svc.closeRace(db, raceId, ctx));
      if (sub === "arrivals" && req.method === "POST") {
        const faultCtx = { ...ctx, fault: req.headers["x-fault"] || null };
        return sendJson(res, 201, svc.registerArrival(db, raceId, body, faultCtx));
      }
      const adjust = sub.match(/^arrivals\/(.+)\/(adjust|void)$/);
      if (adjust && req.method === "POST") {
        const ringNo = decodeURIComponent(adjust[1]);
        return sendJson(res, 200, svc.adjustArrival(db, raceId, ringNo, body, ctx));
      }
    }
    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof svc.HttpError) {
      return sendJson(res, error.status, { error: error.code, message: error.message });
    }
    console.error("[server]", error);
    return sendJson(res, 500, { error: "internal_error", message: error.message });
  }
});

server.listen(port, () => console.log(`赛鸽公棚赛事运营系统 http://localhost:${port} （旧档案入口 /legacy）`));

export { server, db };
