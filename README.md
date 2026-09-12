# 赛鸽公棚赛事运营系统

在原「赛鸽血统环号登记站」基础上扩展的赛事运营系统。旧登记站功能完整保留在 **`/legacy`**，与新系统共用同一份赛鸽档案。

## 启动

```bash
npm start        # http://localhost:3024
```

- `PORT`：监听端口（默认 3024）
- `DATA_DIR`：数据目录（默认 `./data`，可指到持久化卷）
- `FAILPOINT=1`：开启故障注入接口 `POST /api/test/fail-next-write`（仅回归/演练用）

## 运营流程

1. **发布赛事**：名称、距离（公里）、放飞地点，生成赛事编号（R0001…）。
2. **圈定参赛名单**：在「赛事操作」页点选棚号（可多选）按棚圈定，也可按环号手工增补/移出。状态为异常/伤病/失格的赛鸽自动跳过并记入审计。放飞前名单可任意调整。
3. **记录放飞时间**：放飞后赛事锁定名单（不能再增删）。
4. **归巢报到**：录入环号、申报棚号（可空）、实际归巢时间。系统按
   `分速(米/分) = 距离 × 1000 ÷ 实际飞行分钟数` 即时计算分速与名次（分速高者列前，同分速同名次）。
5. **拦截规则**（拒绝并单独写「报到被拦截」审计）：
   - 重复报到（同一赛事同一环号只能报到一次）；
   - 未入选赛鸽（不在本赛事参赛名单内）；
   - 跨棚成绩（申报棚号与登记棚号不符）；
   - 状态异常（异常/伤病/失格）；
   - 未放飞、归巢时间早于放飞时间、赛鸽未登记等。
6. **调整**：报到时间可纠偏调整（全量重算名次）或撤销；名单、报到、排名的所有调整动作都写审计。
7. **审计日志**：「审计日志」页可查全部成功/拦截动作及变更详情。

## 可靠性设计

- **串行事务**：所有写操作经单队列串行执行，并发报到天然安全（同鸽两个并发请求恰好一个成功）。
- **不留半条数据**：事务在内存副本上执行，全部通过才落盘；业务拦截或写盘失败都会回滚内存与文件。报到被拦截时，数据回滚、拦截审计在独立事务中提交。
- **原子落盘**：每个数据文件先写 `*.tmp-*` 临时文件再 `rename` 覆盖；多文件先全部写临时文件再统一替换，失败清理临时文件。
- **重启可查**：数据保存在 `data/pigeons.json`、`data/races.json`、`data/audit.json`，服务重启后全部可查。
- **旧档案入口**：`/legacy` 保留原血统、转让、疫苗、归巢成绩录入页面与接口。

## 测试

```bash
npm test         # node:test 回归：分速名次/四类拦截/重复报到/并发报到/失败恢复/重启持久化/旧档案
npm run test:e2e # Playwright 真实 Chromium 走完整运营流程（截图输出到 test/e2e/screenshots/）
```

回归用例覆盖：

- 重复报到拦截（第二次 400，仅一条报到，有拦截审计）；
- 同鸽并发报到（恰好一个 201、一个 400）、多羽并发报到全部成功且名次连续；
- 写盘失败恢复：故障注入后报到 500，磁盘与内存均无半条数据、无遗留临时文件，后续请求立即恢复；
- 重启后赛事、名单、报到、名次、审计全部可查。

### 无 root 环境的浏览器依赖

Chromium 需要的系统库可在无 sudo 时下载到用户目录（E2E 脚本会自动从 `~/.apt-local/root` 加载）：

```bash
npx playwright install chromium
# 库（任选其一）：
sudo npx playwright install-deps chromium
# 或无 root：
APTROOT=~/.apt-local; mkdir -p $APTROOT
# 用本地 apt 状态 apt-get download libnspr4 libnss3 libxcomposite1 libxdamage1 \
#   libxfixes3 libxrandr2 libasound2 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
#   libdbus-1-3 libgbm1 libxkbcommon0 libxext6 libxrender1 libxi6 libxtst6 libxcb1 \
#   libx11-6 libglib2.0-0 libcups2 libpango-1.0-0 libcairo2 libexpat1 libdrm2 \
#   libwayland-server0，再 dpkg-deb -x 解包到 $APTROOT/root
# 中文字体（截图可读）：apt-get download fonts-wqy-zenhei，把 ttc 放到 ~/.fonts 后 fc-cache -f
```

## 目录结构

```
server.js              入口
src/store.js           原子 JSON 存储 + 串行事务（回滚/故障注入）
src/races.js           赛事领域：发布/圈定/放飞/报到拦截/分速名次/调整/审计
src/legacy.js          旧血统登记站（挂载 /legacy）
src/app-page.js        运营系统页面
src/server.js          HTTP 路由
data/                  持久化 JSON（pigeons / races / audit）
test/races.test.mjs    回归测试
test/e2e/run.mjs       真实浏览器 E2E（截图见 test/e2e/screenshots/）
```

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/races` | 发布赛事 |
| POST | `/api/races/:id/entries/select` | 按棚号圈定 `{lofts:[...]}` |
| POST/DELETE | `/api/races/:id/entries[/:ring]` | 手工增补 / 移出 |
| POST | `/api/races/:id/release` | 记录放飞时间并锁定名单 |
| POST | `/api/races/:id/checkins` | 归巢报到（拦截返回 400 + 错误码） |
| PUT/DELETE | `/api/races/:id/checkins/:ring` | 调整归巢时间（重算名次）/ 撤销报到 |
| POST | `/api/races/:id/close` | 关闭赛事 |
| POST | `/api/pigeons/:ring/status` | 标记 正常/异常/伤病/失格 |
| GET | `/api/audit?target=&action=` | 审计日志（新→旧） |
| GET | `/legacy` `/legacy/api/pigeons*` | 旧血统登记站 |
