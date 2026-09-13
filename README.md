# CF-Worker-Uptime

[![Deploy to Cloudflare Workers](https://img.shields.io/badge/Deploy%20to-Cloudflare%20Workers-orange?style=flat-square&logo=cloudflare)](https://workers.cloudflare.com/)

本项目 fork 自 [CF-Worker-Uptime](https://github.com/afoim/CF-Worker-Uptime)，并在此基础上做了大量修改，部署方式、配置项等可能已与上游不同。

## 部署

部署详见上游文档：[https://github.com/afoim/CF-Worker-Uptime](https://github.com/afoim/CF-Worker-Uptime)

> 注意：由于本项目改动较多，上游文档仅供参考，部分内容可能已不适用。

### D1 读取额度与缓存

- 每分钟检测并保留原始时间戳；历史清理由独立的 `7 * * * *` 每小时任务执行。
- 每次清理最多 4 批、每批 500 条，仅删除超过 14 天的记录；积压会在后续任务中继续清理。
- 状态接口成功数据保留在边缘缓存 24 小时，60 秒内复用；请求合并仅限同一 Worker 实例，缓存共享仅限同一 Cloudflare 节点。
- 上游故障保留成功快照并返回 `X-Status-Stale: true` 和 `X-Status-Updated-At`，前端显示旧数据时间。
- 达到 D1 每日额度后，通过独立失败缓存退避到下一个 UTC 零点，不覆盖成功快照。无快照时返回结构化 503；升级套餐后若要提前恢复，可清除相应边缘缓存并重新部署以清除实例内退避状态。
- 隐藏页面暂停轮询，恢复可见时刷新（仍遵守服务器退避时间）；普通失败指数退避到最多 15 分钟。
- `d1_query` 结构化日志记录实际执行的查询类别、`rows_read`、`rows_written`、耗时。Worker Logs 已启用，可用 `npx wrangler tail` 或 D1 Insights 核对成本。

已有数据库只执行安全索引迁移，**不要运行带 DROP TABLE 的 schema.sql**：

```sh
npx wrangler d1 execute uptime-db --remote --file migrations/0001_history_timestamp_index.sql
npm test
npm run typecheck
npx wrangler deploy
npx wrangler d1 insights uptime-db --timePeriod 1d --sort-type sum --sort-by reads --limit 10 --json
```

迁移可重复执行且不删除数据；若额度耗尽导致迁移失败，必须在配额恢复后重跑并确认索引存在。
本地测试使用 Node.js 22.13+（包含 `node:sqlite`）。类型检查保留项目源码严格检查，跳过依赖库之间冲突的声明检查。
