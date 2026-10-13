# 上游更新核对：2026-10-13

本次核对官方发布说明、包注册表和开源实现，并在本项目中验证选定改动。版本和模型信息是核对日的快照，账号实际权限仍以上游返回为准。

## 模型与协议

- GitHub 已公告部分 GPT-5.4、GPT-5.5 等模型将在 2026-10-19 退役。项目不自动替用户改选其他模型，而是根据模型目录的 `supported_endpoints` 选择 HTTP Chat 或 Responses 路径。客户端应先查询 `/v1/models`；能力详情见 `/api/models/available`。[官方公告](https://github.blog/changelog/2026-09-18-upcoming-deprecation-of-selected-github-copilot-models-in-mid-october/)、[支持模型说明](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- Responses 的 `response.incomplete` 是结束事件。输出或消息数量受限映射为 `length`，内容过滤映射为 `content_filter`，并保留已有内容、usage 和流结束标记；不能识别的结束原因返回明确错误。[OpenAI 事件规范](https://developers.openai.com/api/reference/resources/responses/streaming-events)、[响应对象字段](https://developers.openai.com/api/reference/resources/responses/methods/retrieve)
- 对照了 [ericc-ch/copilot-api v0.7.0](https://github.com/ericc-ch/copilot-api/releases/tag/v0.7.0) 和 [Jer-y/copilot-proxy v0.11.0](https://github.com/Jer-y/copilot-proxy/releases/tag/v0.11.0)。后者的[动态目录改动](https://github.com/Jer-y/copilot-proxy/commit/c7a01e8987a51cf84198bbe0d84ddd3943dbbf97)可作为能力判断参考；本项目仍保留跨协议转换，没有整体合并其架构或认证逻辑。

## 依赖与运行时选择

| 组件 | 原版本 | 本次版本 | 选择依据 |
|---|---|---|---|
| Bun | 1.3.3 | 1.4.3 | 官方稳定版，包含 fetch 取消原因和引用释放修复 |
| Hono | 4.9.9 | 4.13.13 | 当前稳定 4.x，包含安全与 SSE 修复 |
| Undici | 7.16.0 | 7.30.0 | 采用维护中的 7.x 修复线，避免同时引入 8.x dispatcher 变化 |
| srvx | 0.8.9 | 1.0.5 | 稳定版；显式保留 CLI 原有信号退出行为 |
| Knip | 5.64.1 | 6.41.0 | 新版移除 fast-glob/micromatch/braces 依赖链 |
| CI Node.js | runner 默认 | 24.21.0 LTS | 固定已核对的 LTS 版本 |

来源：[Bun 1.4.3](https://bun.com/blog/bun-v1.4.3)、[Hono 4.13.13](https://github.com/honojs/hono/releases/tag/v4.13.13)、[Undici 7.30.0](https://github.com/nodejs/undici/releases/tag/v7.30.0)、[srvx 1.0.5](https://github.com/h3js/srvx/releases/tag/v1.0.5)、[Knip v6 迁移](https://knip.dev/blog/knip-v6)。

双锁文件同时更新。升级 Knip 前剩余的 [braces 告警](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)没有已发布修复版本，因此通过升级父工具移除该依赖，而非忽略告警或使用未经核验的替代包。

TypeScript 保留 5.9.3；现有 `@echristian/eslint-config` 仍依赖旧的 ESLint 插件组合，因此 ESLint 仅更新至 9.39.5。该 ESLint 分支已停止支持，后续应单独迁移 lint 配置，不能将本次描述成所有工具均已升级到最新主版本。[ESLint 支持状态](https://eslint.org/version-support)

## Actions 与验证边界

根据 GitHub 的 [Actions Node 20 运行时调整](https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/)，更新相关 Actions 至官方 Node 24 版本。Bun 与 Node 的 CI 版本分别由 [.bun-version](../.bun-version) 和 [.node-version](../.node-version) 固定。

验证包括模拟上游的协议/取消测试、真实 loopback JSON/SSE/断连测试、双锁文件漏洞审计、类型检查、lint、构建和容器入口检查。loopback 测试只访问本机临时服务，不使用个人账号。没有以真实 Copilot 账号完成模型端到端验证；官方客户端可用模型也不等于每个账号都能通过本项目访问。

本地结果：Bun 1.4.3 下 334 项测试通过，类型检查、lint、构建和 Node CLI 加载通过；Bun 与 npm 的依赖审计均未报告已知漏洞。审计结果对应当日数据库及锁文件，不代表业务代码已经过全面安全审计。
