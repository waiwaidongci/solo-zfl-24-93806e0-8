import Database from "better-sqlite3";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// 演示/测试共用的鸽只档案。旧 pigeons.json 里的三条历史档案会在首次初始化时迁入。
const DEMO_PIGEONS = [
  { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", status: "normal" },
  { ringNo: "CHN-2026-101", owner: "北岸棚", fatherRing: "", motherRing: "", color: "雨点", loft: "北岸A棚", status: "normal" },
  { ringNo: "CHN-2026-102", owner: "北岸棚", fatherRing: "", motherRing: "", color: "灰白条", loft: "北岸A棚", status: "normal" },
  { ringNo: "CHN-2026-103", owner: "北岸棚", fatherRing: "", motherRing: "", color: "绛", loft: "北岸A棚", status: "injured" },
  { ringNo: "CHN-2026-104", owner: "北岸棚", fatherRing: "", motherRing: "", color: "深灰", loft: "北岸A棚", status: "normal" },
  { ringNo: "CHN-2026-201", owner: "南岸棚", fatherRing: "", motherRing: "", color: "灰", loft: "南岸B棚", status: "normal" },
  { ringNo: "CHN-2026-202", owner: "南岸棚", fatherRing: "", motherRing: "", color: "雨点", loft: "南岸B棚", status: "normal" },
  { ringNo: "CHN-2026-203", owner: "南岸棚", fatherRing: "", motherRing: "", color: "白花", loft: "南岸B棚", status: "normal" },
  { ringNo: "CHN-2026-301", owner: "西二棚", fatherRing: "", motherRing: "", color: "黑", loft: "西二C棚", status: "normal" }
];

export function openDb(dbPath, { legacyJsonPath, seedDemo = true } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
  CREATE TABLE IF NOT EXISTS pigeons (
    ring_no TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    father_ring TEXT NOT NULL DEFAULT '',
    mother_ring TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    loft_no TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'normal',
    legacy INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS vaccines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ring_no TEXT NOT NULL REFERENCES pigeons(ring_no),
    date TEXT NOT NULL, name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ring_no TEXT NOT NULL REFERENCES pigeons(ring_no),
    date TEXT NOT NULL, from_owner TEXT NOT NULL, to_owner TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pigeon_race_legacy (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ring_no TEXT NOT NULL REFERENCES pigeons(ring_no),
    date TEXT NOT NULL, event TEXT NOT NULL,
    distance INTEGER NOT NULL DEFAULT 0,
    return_time TEXT NOT NULL DEFAULT '',
    rank INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS races (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    release_at TEXT,
    distance_m INTEGER NOT NULL,
    allowed_lofts TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'published',
    created_by TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    released_at TEXT,
    closed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id INTEGER NOT NULL REFERENCES races(id),
    ring_no TEXT NOT NULL REFERENCES pigeons(ring_no),
    loft_no TEXT NOT NULL,
    selected_by TEXT NOT NULL DEFAULT 'admin',
    selected_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(race_id, ring_no)
  );
  CREATE TABLE IF NOT EXISTS arrivals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id INTEGER NOT NULL REFERENCES races(id),
    ring_no TEXT NOT NULL REFERENCES pigeons(ring_no),
    arrived_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'checkin',
    speed_m_per_min REAL,
    rank INTEGER,
    created_by TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(race_id, ring_no)
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    actor TEXT NOT NULL DEFAULT 'admin',
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT 'success',
    detail TEXT NOT NULL DEFAULT '{}',
    request_id TEXT NOT NULL DEFAULT ''
  );
  `);

  const count = db.prepare("SELECT COUNT(*) AS n FROM pigeons").get().n;
  if (count === 0) {
    const byRing = new Map();
    for (const p of DEMO_PIGEONS) if (seedDemo) byRing.set(p.ringNo, p);

    // 迁移旧 JSON 档案（旧档案入口的数据不丢）
    if (legacyJsonPath && existsSync(legacyJsonPath)) {
      try {
        const legacy = JSON.parse(readFileSync(legacyJsonPath, "utf8"));
        for (const p of legacy.pigeons || []) {
          byRing.set(p.ringNo, {
            ringNo: p.ringNo, owner: p.owner, fatherRing: p.fatherRing || "",
            motherRing: p.motherRing || "", color: p.color || "",
            loft: p.loft || "未分棚", status: "normal", legacy: 1
          });
        }
      } catch (error) {
        console.warn("[migrate] 旧档案读取失败，跳过迁移:", error.message);
      }
    }

    const insertPigeon = db.prepare(`INSERT INTO pigeons
      (ring_no, owner, father_ring, mother_ring, color, loft_no, status, legacy)
      VALUES (@ringNo, @owner, @fatherRing, @motherRing, @color, @loft, @status, @legacy)`);
    const insertVax = db.prepare("INSERT INTO vaccines (ring_no, date, name) VALUES (?, ?, ?)");
    const insertTransfer = db.prepare("INSERT INTO transfers (ring_no, date, from_owner, to_owner) VALUES (?, ?, ?, ?)");
    const insertLegacyRace = db.prepare("INSERT INTO pigeon_race_legacy (ring_no, date, event, distance, return_time, rank) VALUES (?, ?, ?, ?, ?, ?)");

    const legacyRows = legacyJsonPath && existsSync(legacyJsonPath)
      ? JSON.parse(readFileSync(legacyJsonPath, "utf8")).pigeons || []
      : [];
    const extras = new Map(legacyRows.map(p => [p.ringNo, p]));

    const tx = db.transaction(() => {
      for (const p of byRing.values()) {
        insertPigeon.run({ ...p, legacy: p.legacy ? 1 : 0 });
        const extra = extras.get(p.ringNo);
        if (extra) {
          for (const v of extra.vaccines || []) insertVax.run(p.ringNo, v.date, v.name);
          for (const t of extra.transfers || []) insertTransfer.run(p.ringNo, t.date, t.from, t.to);
          for (const r of extra.races || []) insertLegacyRace.run(p.ringNo, r.date, r.event, r.distance, r.returnTime || "", r.rank);
        }
      }
    });
    tx();
    console.log(`[init] 已初始化鸽只档案 ${byRing.size} 条（含旧档案迁移）`);
  }

  return db;
}
