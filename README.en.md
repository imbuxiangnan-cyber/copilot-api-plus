# Copilot API Plus

[![npm version](https://img.shields.io/npm/v/copilot-api-plus.svg)](https://www.npmjs.com/package/copilot-api-plus)
[![license](https://img.shields.io/npm/l/copilot-api-plus.svg)](https://github.com/imbuxiangnan-cyber/copilot-api-plus/blob/main/LICENSE)

English | [简体中文](README.md)

> A proxy that converts GitHub Copilot into OpenAI & Anthropic compatible APIs. Works with Claude Code and more.

---

## 📋 Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
- [Usage Guide](#-usage-guide)
  - [GitHub Copilot Mode](#1-github-copilot-mode-default)
- [Proxy Configuration](#-proxy-configuration)
- [Claude Code Integration](#-claude-code-integration)
- [API Endpoints](#-api-endpoints)
- [API Key Authentication](#-api-key-authentication)
- [Technical Details](#-technical-details)
- [CLI Reference](#️-cli-reference)
- [Docker Deployment](#-docker-deployment)
- [FAQ](#-faq)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔌 **GitHub Copilot Backend** | Access AI models using your GitHub Copilot subscription |
| 🤖 **Dual Protocol** | Supports both OpenAI Chat Completions API and Anthropic Messages API |
| 💻 **Claude Code Integration** | One-command Claude Code setup (`--claude-code`) |
| 📊 **Usage Monitoring** | Real-time API usage dashboard |
| 🔄 **Auto Authentication** | Automatic token refresh, no manual intervention needed |
| ⚡ **Rate Limiting** | Built-in request rate control to avoid hitting limits |
| 🌐 **Proxy Support** | HTTP/HTTPS proxy with persistent configuration |
| 🐳 **Docker Support** | Full Docker deployment solution |
| 🔑 **API Key Auth** | Optional API key authentication for public deployments |
| ✂️ **Context Passthrough** | Full context passthrough to upstream API; clients (e.g. Claude Code) manage compression |
| 🔍 **Smart Model Matching** | Handles model name format differences (date suffixes, dash/dot versions, etc.) |

---

## 🚀 Quick Start

### Installation

```bash
# Global install
npm install -g copilot-api-plus

# Or run directly with npx (recommended)
npx copilot-api-plus@latest start
```

### Basic Usage

```bash
# Start server (defaults to GitHub Copilot)
npx copilot-api-plus@latest start

# Use with Claude Code
npx copilot-api-plus@latest start --claude-code
```

The server listens on `http://localhost:4141` by default.

---

## 📖 Usage Guide

### 1. GitHub Copilot Mode (Default)

Access AI models using your GitHub Copilot subscription.

#### Prerequisites
- GitHub account
- Active Copilot subscription (Individual / Business / Enterprise)

#### Getting Started

```bash
npx copilot-api-plus@latest start
```

**First run** will guide you through GitHub OAuth authentication:

1. A device code appears in the terminal, e.g.: `XXXX-XXXX`
2. Open your browser and visit: https://github.com/login/device
3. Enter the device code and authorize
4. Return to the terminal and wait for authentication to complete

Once authenticated, the token is saved locally. No re-authentication needed on subsequent runs.

#### Business / Enterprise Accounts

```bash
# Business plan
npx copilot-api-plus@latest start --account-type business

# Enterprise plan
npx copilot-api-plus@latest start --account-type enterprise
```

#### Available Models

| Model | ID | Context Length |
|-------|-----|---------------|
| Claude Sonnet 4 | `claude-sonnet-4` | 200K |
| Claude Sonnet 4.5 | `claude-sonnet-4.5` | 200K |
| GPT-4.1 | `gpt-4.1` | 1M |
| o4-mini | `o4-mini` | 200K |
| Gemini 2.5 Pro | `gemini-2.5-pro` | 1M |

---

## 🌐 Proxy Configuration

Two ways to configure a proxy:

### Option 1: Persistent Configuration (Recommended)

Configure once, automatically used on every startup.

```bash
# Interactive setup
npx copilot-api-plus@latest proxy --set

# Or set directly
npx copilot-api-plus@latest proxy --http-proxy http://127.0.0.1:7890

# Set both HTTP and HTTPS proxy
npx copilot-api-plus@latest proxy --http-proxy http://127.0.0.1:7890 --https-proxy http://127.0.0.1:7890
```

#### Proxy Management Commands

```bash
# View current proxy settings
npx copilot-api-plus@latest proxy

# Enable proxy
npx copilot-api-plus@latest proxy --enable

# Disable proxy (keeps settings)
npx copilot-api-plus@latest proxy --disable

# Clear proxy settings
npx copilot-api-plus@latest proxy --clear
```

#### Example: Configure Clash Proxy

```bash
# Clash default port 7890
npx copilot-api-plus@latest proxy --http-proxy http://127.0.0.1:7890

# Verify configuration
npx copilot-api-plus@latest proxy
# Output:
# Current proxy configuration:
#   Status: ✅ Enabled
#   HTTP_PROXY: http://127.0.0.1:7890
#   HTTPS_PROXY: http://127.0.0.1:7890
```

### Option 2: Environment Variables (Temporary)

Only effective for the current session:

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

### Proxy Priority

1. `--proxy-env` flag (reads from environment variables)
2. Persistent configuration (set via `proxy --set`)
3. No proxy

---

## 💻 Claude Code Integration

[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) is Anthropic's AI coding assistant.

### Auto Configuration (Recommended)

```bash
npx copilot-api-plus@latest start --claude-code
```

After running:
1. Select main model (for code generation)
2. Select fast model (for background tasks)
3. The launch command is automatically copied to clipboard
4. **Open a new terminal**, paste and run to start Claude Code

### Manual Configuration

Create `.claude/settings.json` in your project root:

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

Then start the copilot-api-plus server and run `claude` in that project directory.

---

## 📡 API Endpoints

The server listens on `http://localhost:4141` by default.

### OpenAI-Compatible Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions (streaming supported) |
| `/v1/models` | GET | Model list |
| `/v1/embeddings` | POST | Text embeddings (Copilot only) |

### Anthropic-Compatible Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Messages API (streaming supported) |
| `/v1/messages/count_tokens` | POST | Token counting |

### Dedicated Endpoints

Each backend has its own dedicated routes:

| Route Prefix | Description |
|--------------|-------------|
| `/copilot/v1/*` | GitHub Copilot |

### Monitoring Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/usage` | GET | Usage statistics (Copilot only) |
| `/token` | GET | Current token info |

### Examples

```bash
# OpenAI format
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Anthropic format
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

## 🔑 API Key Authentication

To protect your service when exposed publicly, enable API key authentication:

```bash
# Single key
npx copilot-api-plus@latest start --api-key my-secret-key

# Multiple keys
npx copilot-api-plus@latest start --api-key key1 --api-key key2
```

Once enabled, all requests must include an API key:

```bash
# OpenAI format - via Authorization header
curl http://localhost:4141/v1/chat/completions \
  -H "Authorization: Bearer my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hello"}]}'

# Anthropic format - via x-api-key header
curl http://localhost:4141/v1/messages \
  -H "x-api-key: my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'
```

When using with Claude Code, set `ANTHROPIC_AUTH_TOKEN` to your API key.

---

## 🔧 Technical Details

### Context Management

The proxy does not truncate context. All messages are passed through to the upstream API as-is. Context compression is handled by the client:

- **Claude Code**: Uses `/count_tokens` to get the current token count, and automatically triggers `/compact` when approaching the limit
- **Other clients**: If the upstream API returns 400 (token limit exceeded), the client handles retry logic

### Smart Model Name Matching

Anthropic-format model names (e.g. `claude-opus-4-6`) may differ from Copilot's model list IDs. The proxy uses multi-strategy matching:

| Strategy | Example |
|----------|---------|
| Exact match | `claude-opus-4-6` → `claude-opus-4-6` |
| Strip date suffix | `claude-opus-4-6-20251101` → `claude-opus-4-6` |
| Dash → Dot | `claude-opus-4-5` → `claude-opus-4.5` |
| Dot → Dash | `claude-opus-4.5` → `claude-opus-4-5` |

For Anthropic endpoints (`/v1/messages`), `translateModelName` also handles legacy format conversion (e.g. `claude-3-5-sonnet` → `claude-sonnet-4.5`) before applying the above strategies.

### Request Logging

Each API request outputs a log line with model name, status code, and duration:

```log
[claude-opus-4-6] 13:13:39 <-- POST /v1/messages?beta=true
[claude-opus-4-6] 13:13:59 --> POST /v1/messages?beta=true 200 20.1s
```

### Network Retry

Built-in retry for transient network errors (TLS disconnect, connection reset, etc.):

- Up to 2 retries (3 total attempts)
- Backoff intervals: 1s, 2s
- Only retries network-layer errors; HTTP error codes (e.g. 400/500) are not retried

---

## ⚙️ CLI Reference

### Commands

| Command | Description |
|---------|-------------|
| `start` | Start the API server |
| `auth` | Run GitHub authentication only |
| `logout` | Clear saved credentials |
| `proxy` | Configure proxy settings |
| `check-usage` | View Copilot usage |
| `debug` | Show debug information |

### start Options

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `--port` | `-p` | 4141 | Listen port |
| `--verbose` | `-v` | false | Verbose logging |
| `--account-type` | `-a` | individual | Account type (individual/business/enterprise) |
| `--claude-code` | `-c` | false | Generate Claude Code launch command |
| `--rate-limit` | `-r` | - | Request interval (seconds) |
| `--wait` | `-w` | false | Wait instead of error when rate limited |
| `--manual` | - | false | Manually approve each request |
| `--github-token` | `-g` | - | Provide GitHub Token directly |
| `--show-token` | - | false | Show token info |
| `--proxy-env` | - | false | Read proxy from environment variables |
| `--api-key` | - | - | API key auth (can be specified multiple times) |

### proxy Options

| Option | Description |
|--------|-------------|
| `--set` | Interactive proxy setup |
| `--enable` | Enable saved proxy |
| `--disable` | Disable proxy (keeps settings) |
| `--clear` | Clear proxy settings |
| `--show` | Show current settings |
| `--http-proxy` | HTTP proxy URL |
| `--https-proxy` | HTTPS proxy URL |
| `--no-proxy` | Hosts to bypass proxy |

### logout Options

| Option | Alias | Description |
|--------|-------|-------------|
| `--github` | `-g` | Clear GitHub Copilot credentials only |
| `--all` | `-a` | Clear all credentials |

> **Tip**: Running `logout` without arguments shows an interactive menu.

---

## 🐳 Docker Deployment

### Quick Start

```bash
# Using pre-built image
docker run -p 4141:4141 \
  -v ./copilot-data:/root/.local/share/copilot-api-plus \
  ghcr.io/imbuxiangnan-cyber/copilot-api-plus
```

### Build from Source

```bash
# Build image
docker build -t copilot-api-plus .

# Run container
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
      - GH_TOKEN=your_github_token  # Optional
    restart: unless-stopped
```

### Using a Proxy

```bash
docker run -p 4141:4141 \
  -e HTTP_PROXY=http://host.docker.internal:7890 \
  -e HTTPS_PROXY=http://host.docker.internal:7890 \
  -v ./copilot-data:/root/.local/share/copilot-api-plus \
  copilot-api-plus start --proxy-env
```

---

## ❓ FAQ

### Data Storage Location

All data is stored in `~/.local/share/copilot-api-plus/`:

| File | Description |
|------|-------------|
| `github_token` | GitHub Token |
| `config.json` | Proxy and other settings |

### Switching Accounts

```bash
# Interactive credential selection
npx copilot-api-plus@latest logout

# Clear GitHub Copilot credentials only
npx copilot-api-plus@latest logout --github
# Or shorthand
npx copilot-api-plus@latest logout -g

# Clear all credentials
npx copilot-api-plus@latest logout --all
```

### View Usage

```bash
# CLI (Copilot only)
npx copilot-api-plus@latest check-usage
```

After starting the server, you can also access the web dashboard:
```
https://imbuxiangnan-cyber.github.io/copilot-api-plus?endpoint=http://localhost:4141/usage
```

### Debugging

```bash
# Show debug info
npx copilot-api-plus@latest debug

# JSON output
npx copilot-api-plus@latest debug --json

# Enable verbose logging
npx copilot-api-plus@latest start --verbose
```

### Rate Limiting

To avoid triggering GitHub's abuse detection:

```bash
# Set 30-second request interval
npx copilot-api-plus@latest start --rate-limit 30

# Wait instead of error when rate limited
npx copilot-api-plus@latest start --rate-limit 30 --wait

# Manually approve each request
npx copilot-api-plus@latest start --manual
```

---

## ⚠️ Disclaimer

> [!WARNING]
> This is a reverse-engineered proxy for the GitHub Copilot API. **Not officially supported by GitHub** and may stop working at any time. Use at your own risk.

> [!WARNING]
> **GitHub Safety Notice**: Excessive automated or scripted use of Copilot may trigger GitHub's abuse detection systems, resulting in Copilot access suspension. Please use responsibly.
>
> Related policies:
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)

---

## 📄 License

MIT License
