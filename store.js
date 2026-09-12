import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 单文件 JSON 存储,面向赛鸽档案 + 赛事运营数据。
 *
 * 可靠性保证:
 * 1. 原子落盘 —— 先写临时文件并 fsync,再 rename 覆盖正式文件,
 *    任何时刻磁盘上要么是完全的旧数据,要么是完全的新数据,不会出现半笔记录。
 * 2. 串行变更 —— 所有写操作进入同一条 promise 队列,并发请求不会交错写坏文件。
 * 3. 失败回滚 —— 变更过程中任何一步抛错(校验失败、落盘失败),
 *    内存态恢复到变更前快照,临时文件被清理,磁盘文件保持原样。
 */
export class Store {
  /**
   * @param {string} filePath 数据文件路径
   * @param {{ seed: object, migrate?: (db: object) => void }} options
   *   seed: 文件不存在时的初始数据; migrate: 老档案缺字段时的升级钩子
   */
  constructor(filePath, { seed, migrate } = {}) {
    this.filePath = filePath;
    this.tmpPath = `${filePath}.tmp`;
    this.seedData = seed;
    this.migrate = migrate;
    this.db = null;
    this.queue = Promise.resolve();
    // 测试钩子:在真正写盘前调用,可抛错模拟落盘失败
    this.persistHook = null;
  }

  async load() {
    if (!existsSync(this.filePath)) {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.db = structuredClone(this.seedData);
      if (this.migrate) this.migrate(this.db);
      await this.#persist();
    } else {
      this.db = JSON.parse(await readFile(this.filePath, "utf8"));
      if (this.migrate) {
        this.migrate(this.db);
        await this.#persist();
      }
    }
    return this.db;
  }

  /** 读操作直接取内存态(写操作已串行化,内存态始终与磁盘一致)。 */
  get data() {
    return this.db;
  }

  /**
   * 串行执行一次变更:fn 内完成校验与内存修改,成功后原子落盘;
   * 任何异常都会回滚内存态并清理临时文件。
   */
  async mutate(fn) {
    const run = this.queue.then(async () => {
      const snapshot = structuredClone(this.db);
      try {
        const result = await fn(this.db);
        await this.#persist();
        return result;
      } catch (error) {
        this.db = snapshot;
        await unlink(this.tmpPath).catch(() => {});
        throw error;
      }
    });
    // 队列本身不因单次失败而中断
    this.queue = run.catch(() => {});
    return run;
  }

  async #persist() {
    const payload = JSON.stringify(this.db, null, 2);
    if (this.persistHook) await this.persistHook(payload);
    const handle = await open(this.tmpPath, "w");
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(this.tmpPath, this.filePath);
    // 目录 fsync,尽力保证 rename 落盘
    try {
      const dir = await open(dirname(this.filePath), "r");
      await dir.sync();
      await dir.close();
    } catch {
      /* 部分平台不支持目录 fsync,忽略 */
    }
  }
}
