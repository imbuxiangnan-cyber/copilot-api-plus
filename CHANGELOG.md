# 更新记录 / Changelog

已发布版本以 [GitHub Releases](https://github.com/imbuxiangnan-cyber/copilot-api-plus/releases) 为准。`Unreleased` 表示主分支中的改动，不代表 npm 或容器镜像已经发布。

## [Unreleased]

暂无未发布变更。

## [1.8.0] - 2026-10-14

### 2026-10-13 上游兼容与依赖更新

- 升级 Bun 1.4.3、Hono 4.13.13、Undici 7.30.0、srvx 1.0.5，刷新运行和开发依赖的兼容修复版本。
- 升级 Knip 6.41.0，移除没有官方修复版本的旧 braces 依赖链。
- 根据模型目录的 HTTP 能力选择 Responses，目录刷新后不继续使用旧路由学习结果。
- 正确转换 Responses 不完整终态、usage 和结束标记，识别工具输出中的图片。
- 更新 Actions 的 Node 24 运行时，并固定 CI Node 24 LTS；具体取舍和来源见 [上游更新核对](docs/UPSTREAM_SYNC.md)。

### 修复 / Fixed

- 统一 Chat、Responses 和原生 Anthropic 的模型映射、并发控制与账号恢复。
- 模型能力更新后刷新路由缓存；调整并发上限时正确处理排队请求。
- 请求取消可停止排队、上游传输、SSE、Token 刷新及网页工具调用。
- 账号恢复采用刷新后的 Token 与上游地址，保留实际错误和流式账号信息。
- 配置更新串行写入并原子替换，保存成功后再更新运行状态。
- 修正源码启动、Windows 启动器、Docker 参数传递及直接依赖声明。

### 仓库维护 / Repository maintenance

- 增加贡献、安全报告、支持和行为准则文档，以及 Issue/PR 模板。
- 补充可运行的 Compose 示例、环境配置示例和统一运行时版本。
- 增加跨平台 CI、发布前验证、容器构建验证及 Actions 依赖更新配置。

## [1.7.27]

既有已发布版本；详情见 [发布说明](https://github.com/imbuxiangnan-cyber/copilot-api-plus/releases/tag/v1.7.27)。

[Unreleased]: https://github.com/imbuxiangnan-cyber/copilot-api-plus/compare/v1.8.0...main
[1.8.0]: https://github.com/imbuxiangnan-cyber/copilot-api-plus/compare/v1.7.27...v1.8.0
[1.7.27]: https://github.com/imbuxiangnan-cyber/copilot-api-plus/releases/tag/v1.7.27
