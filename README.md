# Copilot API Plus

> **Fork of [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)** with bug fixes and improvements.

将 GitHub Copilot、OpenCode Zen、Google Antigravity 等 AI 服务转换为 **OpenAI** 和 **Anthropic** 兼容 API，支持与 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)、[opencode](https://github.com/sst/opencode) 等工具无缝集成。

---

## 📋 目录

- [功能特点](#-功能特点)
- [快速开始](#-快速开始)
- [三种后端模式](#-三种后端模式)
  - [GitHub Copilot 模式](#1-github-copilot-模式默认)
  - [OpenCode Zen 模式](#2-opencode-zen-模式)
  - [Google Antigravity 模式](#3-google-antigravity-模式)
- [Claude Code 集成](#-claude-code-集成)
- [API 端点](#-api-端点)
- [命令行参数](#-命令行参数)
- [高级配置](#-高级配置)
- [常见问题](#-常见问题)

---

## ✨ 功能特点

| 功能 | 说明 |
|------|------|
| 🔌 **多后端支持** | GitHub Copilot、OpenCode Zen、Google Antigravity 三种后端可选 |
| 🤖 **双协议兼容** | 同时支持 OpenAI Chat Completions API 和 Anthropic Messages API |
| 💻 **Claude Code 集成** | 一键生成 Claude Code 启动命令 (`--claude-code`) |
| 📊 **使用量监控** | Web 仪表盘实时查看 API 使用情况 |
| 🔄 **自动认证** | Token 过期自动刷新，无需手动干预 |
| ⚡ **速率限制** | 内置请求频率控制，避免触发限制 |
| 🐳 **Docker 支持** | 提供完整的 Docker 部署方案 |

---

## 🚀 快速开始

### 使用 npx（推荐）

```bash
# 启动服务器（默认使用 GitHub Copilot）
npx copilot-api-plus@latest start

# 使用 OpenCode Zen
npx copilot-api-plus@latest start --zen

# 使用 Google Antigravity
npx copilot-api-plus@latest start --antigravity
```

### 使用 Docker

```bash
docker run -p 4141:4141 -v ./copilot-data:/root/.local/share/copilot-api-plus ghcr.io/imbuxiangnan-cyber/copilot-api-plus
```

### 本地开发

```bash
bun install
bun run dev
```

---

## 🔧 三种后端模式

### 1. GitHub Copilot 模式（默认）

使用你的 GitHub Copilot 订阅访问 AI 模型。

**前置要求**：
- GitHub 账户
- 有效的 Copilot 订阅（Individual / Business / Enterprise）

**启动方式**：
```bash
npx copilot-api-plus@latest start
```

首次运行会引导你完成 GitHub OAuth 认证：
1. 复制终端显示的设备码
2. 打开 https://github.com/login/device
3. 输入设备码完成授权

**可用模型**：

| 模型 | ID | 说明 |
|------|-----|------|
| Claude Sonnet 4 | `claude-sonnet-4` | Anthropic Claude (200K) |
| Claude Sonnet 4.5 | `claude-sonnet-4.5` | Anthropic Claude (200K) |
| GPT-4.1 | `gpt-4.1` | OpenAI GPT-4.1 (1M) |
| o4-mini | `o4-mini` | OpenAI 推理模型 |
| Gemini 2.5 Pro | `gemini-2.5-pro` | Google Gemini (1M) |

---

### 2. OpenCode Zen 模式

使用 [OpenCode Zen](https://opencode.ai/zen) 的多模型 API 服务。

**前置要求**：
- 访问 https://opencode.ai/zen 注册并获取 API Key

**启动方式**：
```bash
# 交互式输入 API Key
npx copilot-api-plus@latest start --zen

# 或直接指定 API Key
npx copilot-api-plus@latest start --zen --zen-api-key YOUR_API_KEY
```

**可用模型**：

| 模型 | ID | 说明 |
|------|-----|------|
| Claude Sonnet 4.5 | `claude-sonnet-4-5` | Anthropic Claude (200K) |
| Claude Opus 4.5 | `claude-opus-4-5` | Anthropic Claude (200K) |
| GPT-5 Codex | `gpt-5-codex` | OpenAI Responses API |
| Gemini 3 Pro | `gemini-3-pro` | Google Gemini |
| Qwen3 Coder 480B | `qwen3-coder` | Alibaba Qwen |
| Kimi K2 | `kimi-k2` | Moonshot |
| Grok Code Fast 1 | `grok-code` | xAI |

更多模型请访问 [opencode.ai/zen](https://opencode.ai/zen)

---

### 3. Google Antigravity 模式

使用 Google Antigravity API 服务，支持 Gemini 和 Claude 模型。

**前置要求**：
- Google 账户

**启动方式**：
```bash
npx copilot-api-plus@latest start --antigravity
```

首次运行会引导你完成 Google OAuth 认证：
1. 打开终端显示的 Google 授权 URL
2. 完成 Google 登录并授权
3. 复制浏览器地址栏中的回调 URL
4. 粘贴到终端完成认证

**可用模型**：

| 模型 | ID | 说明 |
|------|-----|------|
| Gemini 2.5 Pro | `gemini-2.5-pro-exp-03-25` | Google Gemini |
| Gemini 2.5 Pro Preview | `gemini-2.5-pro-preview-05-06` | Google Gemini |
| Gemini 2.0 Flash | `gemini-2.0-flash-exp` | Google Gemini (快速) |
| Gemini 2.0 Flash Thinking | `gemini-2.0-flash-thinking-exp` | 支持思考链 |
| Claude Opus 4.5 | `claude-opus-4-5` | Anthropic Claude |
| Claude Sonnet 4.5 | `claude-sonnet-4-5` | Anthropic Claude |

**特性**：
- ✅ 自动 Token 刷新
- ✅ 多账户支持，自动轮换
- ✅ 配额用尽自动切换账户
- ✅ 支持 Thinking 模型（思考链输出）

---

## 💻 Claude Code 集成

[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) 是 Anthropic 的 AI 编程助手。本项目支持一键配置。

### 方式一：自动配置（推荐）

使用 `--claude-code` 参数自动生成启动命令：

```bash
# 使用 GitHub Copilot
npx copilot-api-plus@latest start --claude-code

# 使用 OpenCode Zen
npx copilot-api-plus@latest start --zen --claude-code

# 使用 Google Antigravity
npx copilot-api-plus@latest start --antigravity --claude-code
```

按提示选择模型后，会自动复制启动命令到剪贴板。在新终端粘贴运行即可。

### 方式二：手动配置

在项目根目录创建 `.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "claude-sonnet-4",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1"
  }
}
```

---

## 📡 API 端点

服务器启动后，默认监听 `http://localhost:4141`。

### OpenAI 兼容端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | 聊天补全 |
| `/v1/models` | GET | 模型列表 |
| `/v1/embeddings` | POST | 文本嵌入 |

### Anthropic 兼容端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/messages` | POST | 消息 API |
| `/v1/messages/count_tokens` | POST | Token 计数 |

### 专用端点

各后端都有独立的专用路由，即使切换默认后端也能访问：

| 路由前缀 | 说明 |
|----------|------|
| `/copilot/v1/*` | GitHub Copilot 专用 |
| `/zen/v1/*` | OpenCode Zen 专用 |
| `/antigravity/v1/*` | Google Antigravity 专用 |

### 监控端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/usage` | GET | 使用量统计（仅 Copilot） |
| `/token` | GET | 当前 Token 信息 |

---

## ⚙️ 命令行参数

### 命令

| 命令 | 说明 |
|------|------|
| `start` | 启动 API 服务器 |
| `auth` | 仅执行认证流程 |
| `logout` | 清除已保存的凭证 |
| `check-usage` | 查看 Copilot 使用量 |
| `debug` | 显示调试信息 |

### start 命令参数

| 参数 | 别名 | 默认值 | 说明 |
|------|------|--------|------|
| `--port` | `-p` | 4141 | 监听端口 |
| `--verbose` | `-v` | false | 详细日志 |
| `--account-type` | `-a` | individual | 账户类型 (individual/business/enterprise) |
| `--claude-code` | `-c` | false | 生成 Claude Code 启动命令 |
| `--zen` | `-z` | false | 启用 OpenCode Zen 模式 |
| `--zen-api-key` | - | - | Zen API Key |
| `--antigravity` | - | false | 启用 Google Antigravity 模式 |
| `--rate-limit` | `-r` | - | 请求间隔（秒） |
| `--wait` | `-w` | false | 达到限制时等待而非报错 |
| `--manual` | - | false | 手动审批每个请求 |
| `--github-token` | `-g` | - | 直接提供 GitHub Token |
| `--show-token` | - | false | 显示 Token 信息 |
| `--proxy-env` | - | false | 从环境变量读取代理 |

### logout 命令参数

| 参数 | 说明 |
|------|------|
| `--zen` | 仅清除 Zen 凭证 |
| `--antigravity` | 仅清除 Antigravity 凭证 |
| `--all` | 清除所有凭证 |

---

## 🔧 高级配置

### Docker 部署

```bash
# 构建镜像
docker build -t copilot-api-plus .

# 运行容器（持久化数据）
docker run -p 4141:4141 \
  -v ./copilot-data:/root/.local/share/copilot-api-plus \
  copilot-api-plus

# 使用环境变量传递 Token
docker run -p 4141:4141 \
  -e GH_TOKEN=your_github_token \
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

### 代理配置

```bash
# 设置代理环境变量
export HTTP_PROXY=http://proxy:8080
export HTTPS_PROXY=http://proxy:8080

# 启动时启用代理
npx copilot-api-plus@latest start --proxy-env
```

### opencode 集成

创建 `opencode.json`：

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
        "claude-sonnet-4": {
          "name": "Claude Sonnet 4",
          "id": "claude-sonnet-4",
          "max_tokens": 64000,
          "profile": "coder",
          "limit": { "context": 200000 }
        }
      }
    }
  }
}
```

---

## ❓ 常见问题

### 数据存储位置

| 文件 | 路径 |
|------|------|
| GitHub Token | `~/.local/share/copilot-api-plus/github-token.json` |
| Zen API Key | `~/.local/share/copilot-api-plus/zen-auth.json` |
| Antigravity 账户 | `~/.local/share/copilot-api-plus/antigravity-accounts.json` |

### 切换账户

```bash
# 清除 GitHub 凭证
npx copilot-api-plus@latest logout

# 清除 Zen 凭证
npx copilot-api-plus@latest logout --zen

# 清除 Antigravity 凭证
npx copilot-api-plus@latest logout --antigravity

# 清除所有凭证
npx copilot-api-plus@latest logout --all
```

### 查看使用量

```bash
# 命令行查看
npx copilot-api-plus@latest check-usage

# Web 仪表盘（启动服务器后访问）
# https://imbuxiangnan-cyber.github.io/copilot-api-plus?endpoint=http://localhost:4141/usage
```

### 调试问题

```bash
# 显示调试信息
npx copilot-api-plus@latest debug

# JSON 格式输出
npx copilot-api-plus@latest debug --json
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
