import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 原子 JSON 存储：
 * - 所有写操作经串行事务排队，避免并发报到互相覆盖
 * - 事务在内存副本上执行，全部成功才落盘；业务异常或落盘失败都回滚内存
 * - 落盘采用「先写全部临时文件，再逐一 rename」，单条记录不会写坏
 */
export class DomainError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const FILES = {
  pigeons: "pigeons.json",
  races: "races.json",
  audit: "audit.json",
};

export function createStore({ dataDir, clock = () => new Date(), seedPigeons = null } = {}) {
  let state = null;
  let queue = Promise.resolve();
  let failNext = 0; // 故障注入：接下来 N 次落盘失败

  function pathFor(key) {
    return join(dataDir, FILES[key]);
  }

  async function readJson(key, fallback) {
    const p = pathFor(key);
    if (!existsSync(p)) return fallback;
    const text = await readFile(p, "utf8");
    return text.trim() ? JSON.parse(text) : fallback;
  }

  async function init() {
    await mkdir(dataDir, { recursive: true });
    const pigeonDb = await readJson("pigeons", seedPigeons || { pigeons: [] });
    for (const p of pigeonDb.pigeons) {
      if (!p.status) p.status = "正常";
    }
    const raceDb = await readJson("races", { races: [] });
    const auditDb = await readJson("audit", { entries: [] });
    state = {
      pigeons: pigeonDb,
      races: raceDb,
      audit: auditDb,
      seq: auditDb.entries.reduce((m, e) => Math.max(m, e.id || 0), 0),
    };
  }

  /** 故障注入：接下来 n 次落盘抛错（回归测试用） */
  function failWritesFor(n) {
    failNext = n;
  }

  function snapshot() {
    return {
      pigeons: structuredClone(state.pigeons),
      races: structuredClone(state.races),
      audit: structuredClone(state.audit),
      seq: state.seq,
    };
  }

  async function persist(changed, draft) {
    if (failNext > 0) {
      failNext -= 1;
      throw new Error("injected_write_failure");
    }
    // 1) 先把所有变更文件写到临时文件，任一失败则不触碰正式文件
    const tmpPaths = [];
    try {
      for (const key of changed) {
        const tmp = `${pathFor(key)}.tmp-${process.pid}-${draft.seq}-${key}`;
        await writeFile(tmp, JSON.stringify(draft[key], null, 2), "utf8");
        tmpPaths.push({ key, tmp });
      }
      // 2) 临时文件就绪后再 rename 覆盖正式文件
      for (const item of tmpPaths) {
        await rename(item.tmp, pathFor(item.key));
      }
    } catch (err) {
      await Promise.all(tmpPaths.map(({ tmp }) => rm(tmp, { force: true }).catch(() => {})));
      throw err;
    }
  }

  /**
   * 串行事务。mutator(draft, helpers) 在副本上执行，返回需要落盘的文件键数组。
   * mutator 抛 DomainError 或落盘失败：内存状态不变，文件不变（审计也不会留下半条）。
   */
  function tx(mutator) {
    const run = queue.then(async () => {
      const draft = snapshot();
      const helpers = {
        now: clock,
        nextId() {
          draft.seq += 1;
          return draft.seq;
        },
      };
      const changed = await mutator(draft, helpers);
      await persist(changed || [], draft);
      state = draft;
      return state;
    });
    // 队列无论成败都继续推进
    queue = run.then(() => {}, () => {});
    return run;
  }

  /** 只读视图（深拷贝，避免外部误改） */
  async function read() {
    await queue.catch(() => {});
    return snapshot();
  }

  return { init, tx, read, failWritesFor, dataDir, pathFor };
}
