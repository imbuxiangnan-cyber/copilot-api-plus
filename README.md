# Copilot API Plus

[![npm version](https://img.shields.io/npm/v/copilot-api-plus.svg)](https://www.npmjs.com/package/copilot-api-plus)
[![license](https://img.shields.io/npm/l/copilot-api-plus.svg)](https://github.com/imbuxiangnan-cyber/copilot-api-plus/blob/main/LICENSE)

[English](README.en.md) | 简体中文

> A proxy that converts GitHub Copilot into OpenAI & Anthropic compatible APIs. Works with Claude Code, opencode, and more.

将 GitHub Copilot 转换为 **OpenAI** 和 **Anthropic** 兼容 API，支持与 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)、[opencode](https://github.com/sst/opencode) 等工具无缝集成。

---

## 📋 目录

- [功能特点](#-功能特点)
- [快速开始](#-快速开始)
- [详细使用指南](#-详细使用指南)
  - [GitHub Copilot 模式](#1-github-copilot-模式默认)
- [代理配置](#-代理配置)
- [Claude Code 集成](#-claude-code-集成)
- [opencode 集成](#-opencode-集成)
- [API 端点](#-api-端点)
- [API Key 认证](#-api-key-认证)
- [技术细节](#-技术细节)
- [命令行参考](#️-命令行参考)
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
| ✂️ **上下文透传** | 全量透传上下文至上游 API，由客户端（如 Claude Code）自行管理压缩 |
| 🔍 **智能模型匹配** | 自动处理模型名格式差异（日期后缀、dash/dot 版本号等） |

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

| 模型 | ID | 上下文长度 |
|------|-----|-----------|
| Claude Sonnet 4 | `claude-sonnet-4` | 200K |
| Claude Sonnet 4.5 | `claude-sonnet-4.5` | 200K |
| GPT-4.1 | `gpt-4.1` | 1M |
| o4-mini | `o4-mini` | 200K |
| Gemini 2.5 Pro | `gemini-2.5-pro` | 1M |

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
    "ANTHROPIC_MODEL": "claude-sonnet-4",
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
        "claude-sonnet-4": {
          "name": "Claude Sonnet 4",
          "id": "claude-sonnet-4",
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
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Anthropic 格式
curl http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-sonnet-4",
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
  -d '{"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hello"}]}'

# Anthropic 格式 - 通过 x-api-key header
curl http://localhost:4141/v1/messages \
  -H "x-api-key: my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'
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

对于 Anthropic 端点（`/v1/messages`），还会先通过 `translateModelName` 做格式转换（包括旧格式 `claude-3-5-sonnet` → `claude-sonnet-4.5` 的映射），再通过上述策略匹配。

### 请求日志

每次 API 请求会输出一行日志，包含模型名、状态码和耗时：

```log
[claude-opus-4-6] 13:13:39 <-- POST /v1/messages?beta=true
[claude-opus-4-6] 13:13:59 --> POST /v1/messages?beta=true 200 20.1s
```

### 网络重试

对上游 API 的请求内置了瞬时网络错误重试（TLS 断开、连接重置等）：

- 最多重试 2 次（共 3 次尝试）
- 退避间隔：1s、2s
- 仅重试网络层错误，HTTP 错误码（如 400/500）不重试

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
| `config.json` | 代理等配置 |

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
