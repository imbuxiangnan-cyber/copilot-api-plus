# Copilot API Plus

[![npm version](https://img.shields.io/npm/v/copilot-api-plus.svg)](https://www.npmjs.com/package/copilot-api-plus)
[![license](https://img.shields.io/npm/l/copilot-api-plus.svg)](https://github.com/imbuxiangnan-cyber/copilot-api-plus/blob/main/LICENSE)

[English](README.en.md) | 简体中文

> A proxy that converts GitHub Copilot into OpenAI & Anthropic compatible APIs. Works with Claude Code, opencode, and more.

将 GitHub Copilot 转换为 **OpenAI** 和 **Anthropic** 兼容 API，支持与 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)、[opencode](https://github.com/sst/opencode) 等工具无缝集成。

---

## 📋 目录

- [功能特点](#-功能特点)
- [X-CodeAI 推荐服务](#x-codeai-推荐服务)
- [快速开始](#-快速开始)
- [详细使用指南](#-详细使用指南)
  - [GitHub Copilot 模式](#1-github-copilot-模式默认)
- [多账号管理](#-多账号管理)
- [多账号反关联](#️-多账号反关联)
- [模型路由](#-模型路由)
- [代理配置](#-代理配置)
- [Claude Code 集成](#-claude-code-集成)
- [opencode 集成](#-opencode-集成)
- [Cursor IDE 集成](#-cursor-ide-集成)
- [API 端点](#-api-端点)
- [API Key 认证](#-api-key-认证)
- [技术细节](#-技术细节)
- [命令行参考](#️-命令行参考)
- [管理 API](#-管理-api)
- [Docker 部署](#-docker-部署)
- [常见问题](#-常见问题)

---

## ✨ 功能特点

| 功能 | 说明 |
|------|------|
| 🤖 **双协议兼容** | 同时支持 OpenAI Chat Completions API 和 Anthropic Messages API |
| 💻 **Claude Code 集成** | 一键生成 Claude Code 启动命令 (`--claude-code`) |
| 📊 **使用量监控** | Web 仪表盘实时查看 API 使用情况 |
| 🔄 **自动认证** | Token 过期自动刷新，无需手动干预 |
| ⚡ **速率限制** | 内置请求频率控制，避免触发限制 |
| 🌐 **代理支持** | 支持 HTTP/HTTPS 代理，配置持久化 |
| 🐳 **Docker 支持** | 提供完整的 Docker 部署方案 |
| 🔑 **API Key 认证** | 可选的 API Key 鉴权，保护公开部署的服务 |
| 👥 **多账号管理** | 支持添加多个 GitHub 账号，额度耗尽/限流/封禁时自动切换下一个 |
| 🔀 **模型路由** | 灵活的模型名映射和每模型并发控制 |
| 📱 **可视化管理** | Web 仪表盘支持账号管理、模型管理、运行统计 |
| 🛡️ **网络弹性** | 120s 连接超时 + 流中断即时恢复 + 代理隧道保活（30s 心跳，per-account 连接池） |
| ✂️ **上下文透传** | 全量透传上下文至上游 API，由客户端（如 Claude Code）自行管理压缩 |
| 🔍 **智能模型匹配** | 自动处理模型名格式差异（日期后缀、dash/dot 版本号等） |
| 🧠 **Thinking 思维链** | 自动为支持的模型启用深度思考，提升代码质量 |

---

## X-CodeAI 推荐服务

[![X-CodeAI](https://raw.githubusercontent.com/imbuxiangnan-cyber/copilot-api-plus/main/assets/x-codeai-logo.svg)](https://x-codeai.com/)

如果你也在折腾 AI 编程工具，并且觉得官方订阅或 API 成本偏高，可以试试 [X-CodeAI](https://x-codeai.com/)。

X-CodeAI 面向开发者和 AI 工具用户，适合 Claude Code、代码助手、自动化脚本以及各类 API 调用场景。

---

## 🚀 快速开始

### 安装

```bash
# 全局安装
npm install -g copilot-api-plus

# 或使用 npx 直接运行（推荐）
npx copilot-api-plus@latest start
```

### 基本用法

```bash
# 启动服务器（默认使用 GitHub Copilot）
npx copilot-api-plus@latest start

# 与 Claude Code 配合
npx copilot-api-plus@latest start --claude-code
```

服务器启动后，默认监听 `http://localhost:4141`。

---

## 📖 详细使用指南

### 1. GitHub Copilot 模式（默认）

使用你的 GitHub Copilot 订阅访问 AI 模型。

#### 前置要求
- GitHub 账户
- 有效的 Copilot 订阅（Individual / Business / Enterprise）

#### 启动步骤

```bash
npx copilot-api-plus@latest start
```

**首次运行**会引导你完成 GitHub OAuth 认证：

1. 终端显示设备码，例如：`XXXX-XXXX`
2. 打开浏览器访问：https://github.com/login/device
3. 输入设备码，点击授权
4. 返回终端，等待认证完成

认证成功后，Token 会保存到本地，下次启动无需重新认证。

#### 企业/商业账户

```bash
# Business 计划
npx copilot-api-plus@latest start --account-type business

# Enterprise 计划  
npx copilot-api-plus@latest start --account-type enterprise
```

#### 可用模型

> 默认示例推荐使用 `claude-opus-5`。实际可用模型和上下文长度以 `/v1/models` 返回为准。

| 模型 | ID | 上下文长度 |
|------|-----|-----------|
| Claude Opus 5 | `claude-opus-5` | 以 `/v1/models` 返回为准 |
| GPT-4.1 | `gpt-4.1` | 1M |
| o4-mini | `o4-mini` | 200K |
| Gemini 2.5 Pro | `gemini-2.5-pro` | 1M |

---

## 👥 多账号管理

v1.1.0 新增多账号管理功能。当一个账号的额度耗尽、被限流或封禁时，自动无感切换到下一个可用账号。

### 为什么需要多账号？

- **额度池化**：多个账号的 Copilot 额度叠加使用
- **高可用**：单个账号被限流/封禁时，其他账号自动接管
- **无感切换**：客户端（如 Claude Code）完全无需感知，自动完成故障转移

### 添加账号

#### 方式一：CLI 命令（推荐）

通过 GitHub Device Code 流程添加，无需手动获取 Token：

```bash
# 添加新账号
npx copilot-api-plus@latest add-account

# 指定标签
npx copilot-api-plus@latest add-account --label "工作账号"

# 指定账户类型
npx copilot-api-plus@latest add-account --label "企业账号" --account-type business
```

运行后会显示一个设备码，在浏览器中打开 https://github.com/login/device 输入设备码完成授权。

#### 方式二：Web 管理面板

启动服务器后，打开 Usage Viewer 页面，切换到「账号管理」标签页：

1. 点击「添加账号」按钮
2. 选择「Device Code 授权」
3. 按提示在浏览器中完成 GitHub 授权
4. 授权成功后账号自动添加

#### 方式三：API 直接添加

如果你已有 GitHub Token，可以通过 API 直接添加：

```bash
curl -X POST http://localhost:4141/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"githubToken": "ghp_xxx", "label": "我的账号"}'
```

### 管理账号

```bash
# 查看所有账号
npx copilot-api-plus@latest list-accounts

# 输出示例：
# ┌───┬──────────┬──────────┬────────┬───────────────────┐
# │ # │ Label    │ Login    │ Status │ Premium Remaining │
# ├───┼──────────┼──────────┼────────┼───────────────────┤
# │ 1 │ 主账号   │ user1    │ active │ 800/1000          │
# │ 2 │ 备用     │ user2    │ active │ 950/1000          │
# └───┴──────────┴──────────┴────────┴───────────────────┘

# 移除账号（按标签或序号）
npx copilot-api-plus@latest remove-account "主账号"
npx copilot-api-plus@latest remove-account 1
```

### 账号选择策略

系统按以下优先级自动选择最佳账号：

1. **过滤不可用账号**：排除已禁用、已封禁、额度耗尽、冷却中的账号
2. **优先高额度**：剩余额度多的账号排前面
3. **轮询均衡**：额度相同时，最久未使用的优先（round-robin）

### 账号状态说明

| 状态 | 说明 | 自动恢复 |
|------|------|----------|
| `active` | 正常可用 | - |
| `exhausted` | 额度耗尽 | 额度重置后自动恢复 |
| `rate_limited` | 被限流 | 60 秒冷却后自动重试 |
| `banned` | Token 无效/被封 | 需手动处理 |
| `error` | 网络/其他错误 | 60 秒冷却后自动重试 |
| `disabled` | 用户手动禁用 | 需手动启用 |

### 自动迁移

如果你之前使用单账号模式，首次启动 v1.1.0 时，现有账号会自动迁移到多账号管理系统，无需任何操作。

---

## 🛡️ 多账号反关联

v1.2.18 新增。多账号模式下自动启用反关联措施，防止 GitHub 将多个账号关联到同一用户。

### 自动生效（无需配置）

以下措施在多账号模式下**全自动运行**，用户无需任何操作：

| 措施 | 说明 |
|------|------|
| **设备指纹隔离** | 每个账号自动生成独立的 `vscode-machineid`（持久化到 accounts.json）和 `vscode-sessionid`（每次启动重新生成） |
| **连接池隔离** | 每个账号使用独立的 TCP/TLS 连接池，不共享连接 |
| **请求时间隔离** | 切换账号时自动添加 1-5 秒随机延迟，同一账号最小请求间隔 1 秒 |
| **连接池定期重建** | 约 4 小时自动重建连接池（±25% 随机抖动），模拟客户端重启 |

### 高级：Per-account 代理（可选）

如果你有多个代理出口，可以为每个账号配置独立的代理地址，实现**出口 IP 隔离**——这是最强的反关联手段。

> 大部分用户只有一个代理，无需配置此项。上面的自动措施已经足够。

#### 配置方法

直接编辑 `~/.local/share/copilot-api-plus/accounts.json`，为账号添加 `proxy` 字段：

```jsonc
[
  {
    "id": "...",
    "label": "账号1",
    "githubToken": "ghu_xxx",
    "proxy": "http://127.0.0.1:7891"   // 走代理出口 A
  },
  {
    "id": "...",
    "label": "账号2",
    "githubToken": "ghu_yyy",
    "proxy": "socks5://127.0.0.1:7892" // 走代理出口 B
  },
  {
    "id": "...",
    "label": "账号3",
    "githubToken": "ghu_zzz"
    // 不配置 = 使用全局代理或直连
  }
]
```

也可以在添加账号时通过 API 指定：

```bash
curl -X POST http://localhost:4141/admin/accounts \
  -H "Content-Type: application/json" \
  -d '{"githubToken": "ghu_xxx", "label": "账号1", "proxy": "http://127.0.0.1:7891"}'
```

支持 `http://`、`https://`、`socks5://` 协议。修改后重启服务生效。

---

## 🔀 模型路由

v1.1.0 新增模型名映射和并发控制功能。

### 模型名映射

将客户端请求的模型名映射到实际发送给 Copilot 的模型名：

```bash
# 通过 API 配置映射
curl -X PUT http://localhost:4141/api/models/mapping \
  -H "Content-Type: application/json" \
  -d '{"mapping": {"gpt-4": "claude-opus-5", "fast": "gpt-4.1-mini"}}'
```

也可以在 Web 管理面板的「模型管理」标签页中可视化编辑。

#### 通配符映射

使用 `*` 作为 key，将所有未匹配的模型名统一路由：

```bash
curl -X PUT http://localhost:4141/api/models/mapping \
  -H "Content-Type: application/json" \
  -d '{"mapping": {"*": "claude-opus-5"}}'
```

### 并发控制

限制每个模型的最大并发请求数，避免单个模型被过载：

```bash
# 设置并发限制
curl -X PUT http://localhost:4141/api/models/concurrency \
  -H "Content-Type: application/json" \
  -d '{"concurrency": {"claude-opus-5": 5, "default": 10}}'
```

- `default` 是未指定模型的默认并发数
- 超出限制的请求会排队等待，不会被拒绝

### 查看当前配置

```bash
# 查看映射配置
curl http://localhost:4141/api/models/mapping

# 查看并发配置
curl http://localhost:4141/api/models/concurrency

# 查看可用模型列表
curl http://localhost:4141/api/models/available
```

映射和并发配置会持久化到 `config.json`，重启后自动加载。

---

## 🌐 代理配置

如果你需要通过代理访问网络，有两种配置方式：

### 方式一：持久化配置（推荐）

配置一次，永久生效，下次启动自动使用。

```bash
# 交互式配置
npx copilot-api-plus@latest proxy --set

# 或直接设置
npx copilot-api-plus@latest proxy --http-proxy http://127.0.0.1:7890

# 同时设置 HTTP 和 HTTPS 代理
npx copilot-api-plus@latest proxy --http-proxy http://127.0.0.1:7890 --https-proxy http://127.0.0.1:7890
```

#### 代理管理命令

```bash
# 查看当前代理配置
npx copilot-api-plus@latest proxy

# 启用代理
npx copilot-api-plus@latest proxy --enable

# 禁用代理（保留设置）
npx copilot-api-plus@latest proxy --disable

# 清除代理配置
npx copilot-api-plus@latest proxy --clear
```

#### 示例：配置 Clash 代理

```bash
# Clash 默认端口 7890
npx copilot-api-plus@latest proxy --http-proxy http://127.0.0.1:7890

# 验证配置
npx copilot-api-plus@latest proxy
# 输出：
# Current proxy configuration:
#   Status: ✅ Enabled
#   HTTP_PROXY: http://127.0.0.1:7890
#   HTTPS_PROXY: http://127.0.0.1:7890
```

### 方式二：环境变量（临时）

仅当次启动生效：

```bash
# Linux/macOS
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
npx copilot-api-plus@latest start --proxy-env

# Windows PowerShell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
npx copilot-api-plus@latest start --proxy-env

# Windows CMD
set HTTP_PROXY=http://127.0.0.1:7890
set HTTPS_PROXY=http://127.0.0.1:7890
npx copilot-api-plus@latest start --proxy-env
```

### 代理配置优先级

1. `--proxy-env` 参数（从环境变量读取）
2. 持久化配置（`proxy --set` 设置的）
3. 无代理

---

## 💻 Claude Code 集成

[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) 是 Anthropic 的 AI 编程助手。

### 自动配置（推荐）

```bash
npx copilot-api-plus@latest start --claude-code
```

运行后：
1. 选择主模型（用于代码生成）
2. 选择快速模型（用于后台任务）
3. 启动命令会自动复制到剪贴板
4. **打开新终端**，粘贴并运行命令启动 Claude Code

### 手动配置

在项目根目录创建 `.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "claude-opus-5",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1"
  }
}
```

然后启动 copilot-api-plus 服务器后，在该项目目录运行 `claude` 命令。

---

## 🔧 opencode 集成

[opencode](https://github.com/sst/opencode) 是一个现代 AI 编程助手。

### 配置步骤

1. 在项目根目录创建 `opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "copilot-api-plus": {
      "api": "openai-compatible",
      "name": "Copilot API Plus",
      "options": {
        "baseURL": "http://127.0.0.1:4141/v1"
      },
      "models": {
        "claude-opus-5": {
          "name": "Claude Opus 5",
          "id": "claude-opus-5",
          "max_tokens": 64000,
          "profile": "coder",
          "limit": { "context": 200000 }
        },
        "gpt-4.1": {
          "name": "GPT-4.1",
          "id": "gpt-4.1",
          "max_tokens": 32768,
          "profile": "coder",
          "limit": { "context": 1047576 }
        }
      }
    }
  }
}
```

2. 启动 copilot-api-plus：
```bash
npx copilot-api-plus@latest start
```

3. 在同一目录运行 opencode：
```bash
npx opencode@latest
```

4. 选择 `copilot-api-plus` 作为 provider

### 快捷方式：使用环境变量

```bash
# 设置环境变量
export OPENAI_BASE_URL=http://127.0.0.1:4141/v1
export OPENAI_API_KEY=dummy

# 运行 opencode
npx opencode@latest
```

---

## 🖱️ Cursor IDE 集成

[Cursor](https://cursor.com/) 是基于 VS Code 的 AI 编辑器。1.x 版本使用 **OpenAI Responses API** 格式（`input` 数组 + `reasoning` 字段），但仍 POST 到 `/chat/completions` 端点。

copilot-api-plus 会**自动检测** Responses 形态的请求体并转发到 Copilot 的 `/v1/responses` 上游，再把响应翻译回 Chat-Completions 格式 —— **客户端无需任何配置**。

### Cursor 配置步骤

1. 启动 copilot-api-plus：

   ```bash
   npx copilot-api-plus@latest start
   ```

2. 在 Cursor 的 **Settings → Models → API Keys** 中：
   - **OpenAI Base URL**：`http://localhost:4141/v1`
   - **OpenAI API Key**：任意非空字符串（如果没有启用 `--api-key`，填 `dummy` 即可）
3. 在模型列表中添加 `/v1/models` 返回的 Copilot 模型名（如 `gpt-5-mini`、`claude-opus-5` 等），点击 **Verify**

### Cursor 工作原理

- 检测逻辑：请求体含 `input: []` 且不含 `messages: []`，且 `model` 是字符串 → 走 Responses 直通路径
- 同时携带 `messages` 和 `input` 的请求会优先走 Chat 流水线（不会被劫持）
- 流式响应通过 SSE 翻译器逐块转回 Chat-Completion chunk，客户端看到的格式完全一致
- **多账号透明支持**：与 Chat 路径共享同一套轮换 / 熔断 / 抖动 / Token 刷新逻辑，故障转移对 Cursor 无感

### Cursor 已知限制

- Responses 直通路径**不支持** Chat 专属的 `reasoning_effort` 自动降级（如 `high` → `medium`），因为 `/v1/responses` 的 `reasoning: { effort }` 错误信息格式不同。非账号相关的 400（模型不支持、参数无效等）仍会被正确识别并不计入账号失败。

---

## 📡 API 端点

服务器启动后，默认监听 `http://localhost:4141`。

### OpenAI 兼容端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | 聊天补全（支持流式） |
| `/v1/models` | GET | 模型列表 |
| `/v1/embeddings` | POST | 文本嵌入（仅 Copilot） |

### Anthropic 兼容端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/messages` | POST | 消息 API（支持流式） |
| `/v1/messages/count_tokens` | POST | Token 计数 |

### 专用端点

GitHub Copilot 有独立的专用路由：

| 路由前缀 | 说明 |
|----------|------|
| `/copilot/v1/*` | GitHub Copilot 专用 |

### 监控端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/usage` | GET | 使用量统计（仅 Copilot） |
| `/token` | GET | 当前 Token 信息 |

### 调用示例

```bash
# OpenAI 格式
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Anthropic 格式
curl http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-opus-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

---

## ⚙️ 命令行参考

### 命令列表

| 命令 | 说明 |
|------|------|
| `start` | 启动 API 服务器 |
| `auth` | 仅执行 GitHub 认证流程 |
| `logout` | 清除已保存的凭证 |
| `proxy` | 配置代理设置 |
| `check-usage` | 查看 Copilot 使用量 |
| `debug` | 显示调试信息 |
| `add-account` | 通过 Device Code 添加新 GitHub 账号 |
| `list-accounts` | 列出所有已配置的账号 |
| `remove-account` | 按标签或序号移除账号 |

### start 命令参数

| 参数 | 别名 | 默认值 | 说明 |
|------|------|--------|------|
| `--port` | `-p` | 4141 | 监听端口 |
| `--verbose` | `-v` | false | 详细日志 |
| `--account-type` | `-a` | individual | 账户类型 (individual/business/enterprise) |
| `--claude-code` | `-c` | false | 生成 Claude Code 启动命令 |
| `--rate-limit` | `-r` | - | 请求间隔（秒） |
| `--wait` | `-w` | false | 达到限制时等待而非报错 |
| `--manual` | - | false | 手动审批每个请求 |
| `--github-token` | `-g` | - | 直接提供 GitHub Token |
| `--show-token` | - | false | 显示 Token 信息 |
| `--proxy-env` | - | false | 从环境变量读取代理 |
| `--api-key` | - | - | API Key 鉴权（可多次指定） |

### proxy 命令参数

| 参数 | 说明 |
|------|------|
| `--set` | 交互式配置代理 |
| `--enable` | 启用已保存的代理 |
| `--disable` | 禁用代理（保留设置） |
| `--clear` | 清除代理配置 |
| `--show` | 显示当前配置 |
| `--http-proxy` | HTTP 代理 URL |
| `--https-proxy` | HTTPS 代理 URL |
| `--no-proxy` | 不走代理的主机列表 |

### logout 命令参数

| 参数 | 别名 | 说明 |
|------|------|------|
| `--github` | `-g` | 仅清除 GitHub Copilot 凭证 |
| `--all` | `-a` | 清除所有凭证 |

> **提示**：不带参数运行 `logout` 会显示交互式菜单供选择。

### add-account 命令参数

| 参数 | 别名 | 默认值 | 说明 |
|------|------|--------|------|
| `--label` | `-l` | - | 账号标签 |
| `--account-type` | `-a` | individual | 账户类型 (individual/business/enterprise) |
| `--verbose` | `-v` | false | 详细日志 |

### list-accounts 命令参数

| 参数 | 别名 | 默认值 | 说明 |
|------|------|--------|------|
| `--verbose` | `-v` | false | 详细日志 |

### remove-account 命令参数

| 参数 | 别名 | 默认值 | 说明 |
|------|------|--------|------|
| `<id>` | - | - | 账号标签或序号（位置参数） |
| `--label` | `-l` | - | 账号标签 |
| `--force` | `-f` | false | 跳过确认提示 |
| `--verbose` | `-v` | false | 详细日志 |

---

## 📡 管理 API

v1.1.0 新增 REST 管理 API，支持通过 HTTP 接口管理账号、模型配置和查看运行统计。所有端点挂载在 `/api` 前缀下。

### 账号管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/accounts` | 列出所有账号（Token 脱敏） |
| POST | `/api/accounts` | 添加账号（需提供 `githubToken` 和 `label`） |
| DELETE | `/api/accounts/:id` | 按 ID 删除账号 |
| PUT | `/api/accounts/:id/status` | 启用/禁用账号（`"active"` 或 `"disabled"`） |
| POST | `/api/accounts/:id/refresh` | 手动刷新指定账号的 Token 和配额 |
| GET | `/api/accounts/usage` | 聚合所有账号的配额统计 |

#### Device Code 授权流程（Web 端用）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/accounts/auth/start` | 发起 GitHub Device Code 授权，返回设备码和验证 URL |
| POST | `/api/accounts/auth/poll` | 轮询授权状态（需提供 `device_code`），授权成功后自动添加账号 |

#### 示例

```bash
# 列出所有账号
curl http://localhost:4141/api/accounts

# 添加账号
curl -X POST http://localhost:4141/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"githubToken": "ghp_xxx", "label": "我的账号"}'

# 启用/禁用账号
curl -X PUT http://localhost:4141/api/accounts/<account-id>/status \
  -H "Content-Type: application/json" \
  -d '{"status": "disabled"}'

# 手动刷新账号
curl -X POST http://localhost:4141/api/accounts/<account-id>/refresh

# 查看聚合配额
curl http://localhost:4141/api/accounts/usage
```

### 模型管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/models/available` | 列出 Copilot 返回的所有可用模型 |
| GET | `/api/models/mapping` | 查看当前模型映射配置 |
| PUT | `/api/models/mapping` | 更新模型映射（需提供 `mapping` 对象） |
| GET | `/api/models/concurrency` | 查看当前并发配置 |
| PUT | `/api/models/concurrency` | 更新并发配置（需提供 `concurrency` 对象，值为正整数） |

#### 示例

```bash
# 查看可用模型
curl http://localhost:4141/api/models/available

# 设置模型映射
curl -X PUT http://localhost:4141/api/models/mapping \
  -H "Content-Type: application/json" \
  -d '{"mapping": {"gpt-4": "claude-opus-5", "*": "claude-opus-5"}}'

# 设置并发限制
curl -X PUT http://localhost:4141/api/models/concurrency \
  -H "Content-Type: application/json" \
  -d '{"concurrency": {"claude-opus-5": 5, "default": 10}}'
```

### 运行统计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats` | 运行时统计（账号数、活跃数、模型并发情况、运行时长） |

```bash
curl http://localhost:4141/api/stats
# 返回: {"accounts":{"total":2,"active":2},"models":{...},"uptime":3600}
```

---

## 🔑 API Key 认证

如果你将服务暴露到公网，可以启用 API Key 认证来保护接口：

```bash
# 单个 Key
npx copilot-api-plus@latest start --api-key my-secret-key

# 多个 Key
npx copilot-api-plus@latest start --api-key key1 --api-key key2
```

启用后，所有请求需要携带 API Key：

```bash
# OpenAI 格式 - 通过 Authorization header
curl http://localhost:4141/v1/chat/completions \
  -H "Authorization: Bearer my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-5", "messages": [{"role": "user", "content": "Hello"}]}'

# Anthropic 格式 - 通过 x-api-key header
curl http://localhost:4141/v1/messages \
  -H "x-api-key: my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-5", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'
```

在 Claude Code 中使用时，将 `ANTHROPIC_AUTH_TOKEN` 设为你的 API Key 即可。

---

## 🔧 技术细节

### 上下文管理

代理层不做上下文截断，全量透传消息至上游 API。上下文压缩由客户端负责：

- **Claude Code**：通过 `/count_tokens` 端点获取当前 token 数，接近上限时自动触发 `/compact` 压缩
- **其他客户端**：如果上游 API 返回 400（token 超限），客户端自行处理重试

### 智能模型名匹配

Anthropic 格式的模型名（如 `claude-opus-4-6`）和 Copilot 的模型列表 ID 可能存在格式差异。代理使用多策略精确匹配：

| 策略 | 示例 |
|------|------|
| 精确匹配 | `claude-opus-4-6` → `claude-opus-4-6` |
| 去日期后缀 | `claude-opus-4-6-20251101` → `claude-opus-4-6` |
| Dash → Dot | `claude-opus-4-5` → `claude-opus-4.5` |
| Dot → Dash | `claude-opus-4.5` → `claude-opus-4-5` |

对于 Anthropic 端点（`/v1/messages`），还会先通过 `translateModelName` 做旧格式/别名转换，再通过上述策略匹配。

### 请求日志

每次 API 请求会输出一行日志，包含模型名、状态码和耗时：

```log
[claude-opus-4-6 thinking] 13:13:39 <-- POST /v1/messages?beta=true
[claude-opus-4-6 thinking] 13:13:59 --> POST /v1/messages?beta=true 200 20.1s
```

### 网络弹性

对上游 API 的请求内置了连接超时和代理隧道保活，确保 SSE 流式传输的稳定性：

- **连接超时**：120 秒等待响应头（thinking 模型可能需要 60-120 秒才开始流式输出）
- **无网络层重试**：请求到达 Copilot 即消耗额度，重试会浪费额度。由调用方（如 Claude Code）在应用层决定是否重试
- **流中断即时恢复**：SSE 流中断时立刻销毁连接池，下一个请求使用全新连接，恢复时间从 ~135 秒降至几秒
- **代理隧道保活**：SSE 流传输期间每 30 秒通过**对应账号的连接池**发送心跳请求，防止代理节点因空闲而杀断 CONNECT 隧道（多账号模式下每个账号独立保活）
- SSE 流传输中断时，优雅地向客户端发送错误事件

---

## 🐳 Docker 部署

### 快速启动

```bash
# 使用预构建镜像
docker run -p 4141:4141 \
  -v ./copilot-data:/root/.local/share/copilot-api-plus \
  ghcr.io/imbuxiangnan-cyber/copilot-api-plus
```

### 自行构建

```bash
# 构建镜像
docker build -t copilot-api-plus .

# 运行容器
docker run -p 4141:4141 \
  -v ./copilot-data:/root/.local/share/copilot-api-plus \
  copilot-api-plus
```

### Docker Compose

```yaml
version: "3.8"
services:
  copilot-api-plus:
    build: .
    ports:
      - "4141:4141"
    volumes:
      - ./copilot-data:/root/.local/share/copilot-api-plus
    environment:
      - GH_TOKEN=your_github_token  # 可选
    restart: unless-stopped
```

### 使用代理

```bash
docker run -p 4141:4141 \
  -e HTTP_PROXY=http://host.docker.internal:7890 \
  -e HTTPS_PROXY=http://host.docker.internal:7890 \
  -v ./copilot-data:/root/.local/share/copilot-api-plus \
  copilot-api-plus start --proxy-env
```

---

## ❓ 常见问题

### 数据存储位置

所有数据存储在 `~/.local/share/copilot-api-plus/` 目录下：

| 文件 | 说明 |
|------|------|
| `github_token` | GitHub Token |
| `config.json` | 代理、模型映射、并发等配置 |
| `accounts.json` | 多账号数据（Token、状态、配额等） |

### 切换账户

```bash
# 交互式选择要清除的凭证
npx copilot-api-plus@latest logout

# 仅清除 GitHub Copilot 凭证
npx copilot-api-plus@latest logout --github
# 或简写
npx copilot-api-plus@latest logout -g

# 清除所有凭证
npx copilot-api-plus@latest logout --all
```

### 查看使用量

```bash
# 命令行查看（仅 Copilot）
npx copilot-api-plus@latest check-usage
```

启动服务器后，也可以访问 Web 仪表盘：
```
https://imbuxiangnan-cyber.github.io/copilot-api-plus?endpoint=http://localhost:4141/usage
```

### 调试问题

```bash
# 显示调试信息
npx copilot-api-plus@latest debug

# JSON 格式输出
npx copilot-api-plus@latest debug --json

# 启用详细日志
npx copilot-api-plus@latest start --verbose
```

### 速率限制

避免触发 GitHub 的滥用检测：

```bash
# 设置请求间隔 30 秒
npx copilot-api-plus@latest start --rate-limit 30

# 达到限制时等待而非报错
npx copilot-api-plus@latest start --rate-limit 30 --wait

# 手动审批每个请求
npx copilot-api-plus@latest start --manual
```

---

## ⚠️ 免责声明

> [!WARNING]
> 这是 GitHub Copilot API 的逆向工程代理。**不受 GitHub 官方支持**，可能随时失效。使用风险自负。

> [!WARNING]
> **GitHub 安全提示**：过度的自动化或脚本化使用 Copilot 可能触发 GitHub 的滥用检测系统，导致 Copilot 访问被暂停。请负责任地使用。
>
> 相关政策：
> - [GitHub 可接受使用政策](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies)
> - [GitHub Copilot 条款](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)

---

## 📄 许可证

MIT License
