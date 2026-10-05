# 发布说明（维护者）

仓库提交、GitHub Release、npm 包和 GHCR 镜像是不同的交付物。推送 `main` 会运行 CI；只有版本 tag 才会触发 GitHub Release 和镜像发布。`CHANGELOG.md` 的 `Unreleased` 不代表 npm 已更新。

## 发布前

1. 确认目标提交的 Linux 与 Windows CI 均通过。
2. 整理 [CHANGELOG.md](../CHANGELOG.md)，同步中英文 README 中的用法变化。
3. 在本地运行完整检查：

   ```bash
   bun install --frozen-lockfile
   bun run lint:all
   bun run typecheck
   bun test
   bun run build
   ```

4. 在 [Docker Build and Push](https://github.com/imbuxiangnan-cyber/copilot-api-plus/actions/workflows/release-docker.yml) 中手动运行构建验证。手动运行只构建和检查入口，不发布镜像。

## 版本与发布

版本 tag 必须是 `v` 加上 `package.json` 的完整版本，例如版本 `X.Y.Z` 对应 `vX.Y.Z`。发布工作流会检查两者一致，并重新执行完整验证。

现有 `bun run release` 会调用 `bumpp` 更新版本并处理 Git 提交/tag，再执行 `bun publish --access public`。运行前确认交互选项、目标远程仓库及 npm 发布账号；它会产生对外发布操作。npm 发布需要维护者自己的有效认证，不能把凭据提交进仓库。

- **GitHub Release**：版本 tag 推送后，通过验证才创建，并生成发布说明。
- **预发布版本**：如 `vX.Y.Z-beta.1` 会标记为 prerelease，不会设为 Latest；`+build` 元数据本身不代表预发布。
- **GHCR**：版本 tag 推送后，通过验证才构建并推送 `amd64` / `arm64` 镜像。
- **npm**：由 `bun run release` 中的 `bun publish` 完成；GitHub 工作流本身不发布 npm 包。

不要为了重试发布而强制移动已发布的 tag。部分渠道失败时，先检查失败阶段及已发布内容，避免重复发布或误认为所有渠道已同步。

## 发布后核对

- [Actions](https://github.com/imbuxiangnan-cyber/copilot-api-plus/actions) 中的验证、Release 和容器发布结果。
- [GitHub Releases](https://github.com/imbuxiangnan-cyber/copilot-api-plus/releases) 中的版本及说明。
- npm 包版本与相应 GHCR 镜像标签。
- 用 `--help` 检查安装后的 CLI 入口；真实上游验证另用已授权的测试账号执行。

English summary: Tag and package versions must match. Tag workflows validate before publishing GitHub releases and container images. npm publication remains a separate authenticated maintainer action.
