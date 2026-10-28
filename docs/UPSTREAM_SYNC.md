# 上游更新核对：2026-10-28

本次在 1.8.0 基础上核对官方文档、发布说明和开源项目，变更纳入 1.8.1。各渠道的实际发布状态以 GitHub Releases、npm 注册表和 GHCR 为准。

## 协议与稳定性修复

- 根据 [OpenAI 官方迁移文档](https://developers.openai.com/api/docs/guides/migrate-to-responses)，将 Chat 的 `response_format` 映射到 Responses 的 `text.format`，保留 JSON Schema 的名称、描述和严格模式。工具定义保留显式 `strict`，未设置时显式使用 `false` 以保持 Chat 默认语义；同时保留 `parallel_tool_calls: false`。测试覆盖模型目录直接路由和 Chat 被拒后自动回退两条路径。
- 按 [Anthropic 思考预算规则](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)修正旧版 Claude 自动注入的 `budget_tokens`：预算至少 1024，且小于 `max_tokens`；无法满足时不自动开启。显式关闭思考不再被翻译成高思考强度，强制工具选择与思考的组合遵守[官方限制](https://platform.claude.com/docs/en/build-with-claude/thinking)。
- 参考 [WHATWG 重定向流程](https://fetch.spec.whatwg.org/#http-redirect-fetch)、[OWASP SSRF 指南](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)和 [Undici 资源释放要求](https://github.com/nodejs/undici#garbage-collection)，WebFetch 改为手动跟随并逐跳检查地址，上限 20 次，并保留同一个超时与取消信号。中间响应和搜索错误响应取消未读 body，读取结束释放 reader lock。地址检查覆盖 URL 中的私网字面地址，不解析 DNS，也不构成对 DNS 重绑定的完整防御；部署仍需出口访问控制。

## 开源项目对照

核对了原始上游 [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) 的默认分支（`0ea08febdd7e3e055b03dd298bf57e669500b5c1`）和 [Jer-y/copilot-proxy](https://github.com/Jer-y/copilot-proxy) 的默认分支（`3d7666922cf52a12da1c4dd1af2b8c58c882c1a8`）。这两个分支相对上次核对没有新的代码更新，因此没有直接合并其认证或路由实现。本轮协议修复依据当前官方规范，并对照 [OpenAI Node SDK 的请求类型](https://github.com/openai/openai-node/blob/d6c84252c9c55f1e047104d1dc3e0ac896bae38c/src/resources/shared.ts#L511)和 [Anthropic SDK 的思考类型](https://github.com/anthropics/anthropic-sdk-typescript/blob/cb5fba419808e3844fa6407e59577ab7ba346b79/src/resources/messages/messages.ts#L5511)核查字段和预算约束。

## 依赖与运行时

| 组件 | 1.8.0 | 本次选择 | 依据 |
|---|---|---|---|
| Bun / Bun 类型 | 1.4.3 | 1.4.4 | [官方修复说明](https://bun.com/blog/bun-v1.4.4) |
| Hono | 4.13.13 | 4.13.14 | [同主版本修复](https://github.com/honojs/hono/releases/tag/v4.13.14) |
| Undici | 7.30.0 | 7.30.1 | [安全修复版本](https://github.com/nodejs/undici/releases/tag/v7.30.1) |
| srvx | 1.0.5 | 1.0.8 | [Node 空流响应头修复](https://github.com/h3js/srvx/releases/tag/v1.0.8) |
| Knip | 6.41.0 | 6.43.0 | [发布说明](https://github.com/webpro-nl/knip/releases/tag/knip%406.43.0) |
| CI Node 24 LTS | 24.21.0 | 24.22.1 | [官方安全发布](https://nodejs.org/en/blog/release/v24.22.1) |

保留运行最低 Node.js 20.18.1；开发工具 Knip 需要 Node.js `^20.19.0 || >=22.12.0`，开发与 CI 应使用已固定的 Node 24 LTS。TypeScript 5 与 ESLint 9 暂时保留此前兼容性约束，不将这轮描述为所有组件均为最新主版本。

## 验证

本地 Bun 1.4.4 下 391 项测试通过（35 个测试文件、1,280 项断言），类型检查、完整 lint、构建和 Node CLI 加载通过。类型检查已排除生成的 `dist`，与构建清理同时执行也通过。Bun frozen-lockfile 安装通过，两锁文件的直接依赖版本一致，Bun 与 npm 审计均报告 0 个已知漏洞；npm 打包预览仅包含预期的 13 个文件。

独立临时项目中的完整 `npm ci` 和生产 `npm ci --omit=dev` 均成功，生产依赖树检查无问题。npm 10.9.2 的完整开发安装将六个锁中已有的可选 WASM 辅助依赖标为 `extraneous`，没有缺失或无效依赖；生产安装没有此提示。

本轮使用模拟上游及本机服务验证，没有使用真实 Copilot 凭据，也未执行远程 CI 或 Docker 镜像构建。Node CLI 本地使用 Node.js 22.15.0 验证；Node 24.22.1 是 CI 的版本配置。通过这些检查不能保证每个账号均能使用官方客户端列出的所有模型，审计结果也只对应当前锁文件与核对时的漏洞数据库。

---

# 历史核对：2026-10-13（1.8.0）

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
