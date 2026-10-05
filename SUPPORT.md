# 使用支持

先查阅 [中文 README](README.md) 或 [English README](README.en.md) 中的安装、客户端配置、代理和常见问题说明，再搜索 [已有 Issues](https://github.com/imbuxiangnan-cyber/copilot-api-plus/issues)。

如果仍无法解决，可通过 [新建 Issue](https://github.com/imbuxiangnan-cyber/copilot-api-plus/issues/new/choose) 报告问题或提出功能建议。中文和英文均可。

## 提供可复现信息

- 项目版本或 commit、操作系统、Bun/Node 版本，以及安装方式（源码、npm/npx 或 Docker）。
- 使用的客户端及版本、请求端点、模型名称、是否流式，以及是否使用代理或多账号。
- 最小复现步骤、预期结果、实际结果和 HTTP 状态码。
- 已做的排查，以及经过脱敏的启动参数、请求样例和相关日志。

功能建议请描述具体使用场景、当前遇到的限制和期望行为。报告已有问题时，补充新的复现信息即可，无需反复创建相同 Issue。

## 保护凭据与数据

提交前移除 `Authorization`、`x-api-key`、URL 中的 `apiKey`、Token、带密码的代理地址和私人请求内容。不要上传 `.env`、完整账号文件或启用 `--show-token` 后的原始输出。截图和粘贴的终端输出也需要检查。

怀疑存在安全漏洞时，改走 [私密安全报告](SECURITY.md)。贡献代码或测试请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 支持边界

这是社区维护的非官方 GitHub Copilot 兼容代理。账号订阅、扣费、账号处罚及上游服务故障需要联系对应服务的官方支持；本仓库无法调整这些状态。

Issue 用于协作排查和跟踪改进，不代表固定响应时限、商业技术支持或对所有旧版本的兼容保证。为了复现问题，讨论中可能需要补充版本信息、最小样例或验证结果。
