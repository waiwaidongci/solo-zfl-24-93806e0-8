# 赛鸽公棚赛事运营系统

在原有「赛鸽血统环号登记站」之上新增赛事运营能力,旧档案入口照常可用。

## 运行

```bash
npm start          # http://localhost:3024
```

- `http://localhost:3024/` —— 旧档案入口(档案、血统、转让、归巢成绩)
- `http://localhost:3024/races` —— 赛事运营后台

## 功能

- **发布赛事**:填写名称、空距,按棚号从已登记赛鸽中自动圈定参赛名单;草稿期可增删名单,发布后锁定。
- **放飞**:记录放飞时间,赛事进入可报到状态。
- **归巢报到**:按空距与实际用时自动计算分速(米/分)并重排名次;支持作废报到(调整动作)并自动重排;封存后名次定稿。
- **拦截**:`duplicate_checkin` 重复报到、`not_in_roster` 未入选赛鸽、`cross_loft` 跨棚成绩、`invalid_status` 状态异常、`invalid_time` 归巢时间不合法。
- **审计留痕**:建赛、圈定名单、名单调整、发布、放飞、报到、作废、封存全部落审计(`GET /api/audit`)。
- **可靠性**:所有变更串行化,先写临时文件 fsync 再 rename 原子落盘;任何一步失败内存态回滚,不留半笔记录;重启后数据仍在。

## API 一览

```
POST /api/races                          创建赛事(按 lofts 圈定名单)
POST /api/races/:id/roster               草稿期调整名单 { add, remove }
POST /api/races/:id/publish              发布,锁定名单
POST /api/races/:id/release              记录放飞时间 { releaseTime }
POST /api/races/:id/checkins             归巢报到 { ringNo, loft, arrivalTime }
POST /api/races/:id/checkins/:ring/void  作废报到 { reason }
POST /api/races/:id/close                封存,名次定稿
GET  /api/races | /api/races/:id         赛事列表 / 详情(含成绩榜)
GET  /api/audit?raceId=                  审计留痕
GET  /api/lofts                          已登记棚号
GET  /api/pigeons ...                    旧档案接口(原样保留)
```

## 测试与验证

```bash
npm test                               # 回归:重复报到/并发报到/失败恢复/重启恢复/旧档案
node scripts/verify-browser.mjs        # 真实浏览器逐项验证(需先 npm i 且服务已启动)
```

浏览器验证截图见 `verification/`。
