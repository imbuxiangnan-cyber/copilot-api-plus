# 贡献指南

欢迎提交问题复现、修复、测试和文档改进。使用问题请先看 [支持说明](SUPPORT.md)，安全漏洞请按 [安全报告流程](SECURITY.md) 私密提交。参与讨论和代码评审时，请遵守 [行为准则](CODE_OF_CONDUCT.md)。

English contributions are welcome. Please include reproduction steps, the expected behavior, and your validation results.

## 本地开发

项目使用 Bun、严格模式 TypeScript 和 Hono。从仓库的 `main` 分支创建主题分支，在仓库根目录执行：

使用 [.bun-version](.bun-version) 指定的 Bun 版本，与 CI 和 Docker 保持一致。

```bash
bun install --frozen-lockfile
bun run dev
```

`bun run dev` 已包含 `start` 子命令，会启动服务；追加参数可用 `bun run dev --port 4142`。真实服务启动可能读取本机已保存的账号并访问 GitHub，首次登录还可能进入设备授权流程。运行自动化测试不需要启动服务或提供真实 Token。

代码入口和约定：

- [src/main.ts](src/main.ts)：CLI 子命令；[src/server.ts](src/server.ts)：HTTP 路由。
- [src/routes](src/routes)：协议入口和管理接口；[src/services](src/services)：上游调用与转换；[src/lib](src/lib)：共享逻辑。
- [tests](tests)：Bun 测试，文件名使用 `*.test.ts`。
- [AGENTS.md](AGENTS.md)：导入、类型、命名与其他代码约定。

## 测试与验证

修复问题时，优先增加能复现原错误的测试。模拟 `fetch`、认证和上游错误，不使用真实 GitHub/Copilot Token，也不读取或修改个人的 `github_token`、`accounts.json` 或 `config.json`。需要磁盘读写的测试使用临时目录；测试结束后恢复路径、全局状态和 spy，并清理临时文件。涉及流式响应时，同时考虑正常结束、异常和客户端取消。

先运行相关测试，例如：

```bash
bun test tests/anthropic-request.test.ts
```

提交代码前，执行与 [CI](.github/workflows/ci.yml) 一致的检查：

```bash
bun run lint:all
bun run typecheck
bun test
bun run build
```

依赖变更应同步提交相关锁文件。不要把 Token、带凭据的代理地址、个人配置或未经脱敏的请求日志加入提交。

## 提交 Pull Request

将 PR 的目标分支设为 `main`，每个 PR 尽量解决一个明确问题。说明原行为、修改后的行为，以及实际运行的验证命令和结果；关联已有 Issue，界面变更可附脱敏截图。

新增参数、修改接口或改变默认行为时，同步更新 [中文 README](README.md) 和 [英文 README](README.en.md) 中受影响的说明。较大的行为变更可先通过 Issue 说明使用场景和方案，减少重复工作。若某项验证未运行或受环境限制，请在 PR 中明确注明。

维护者发布版本前请阅读 [发布说明](docs/RELEASING.md)。
