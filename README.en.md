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
- [Multi-Account Management](#-multi-account-management)
- [Multi-Account Anti-Correlation](#️-multi-account-anti-correlation)
- [Model Routing](#-model-routing)
- [Proxy Configuration](#-proxy-configuration)
- [Claude Code Integration](#-claude-code-integration)
- [opencode Integration](#-opencode-integration)
- [API Endpoints](#-api-endpoints)
- [API Key Authentication](#-api-key-authentication)
- [Technical Details](#-technical-details)
- [CLI Reference](#️-cli-reference)
- [Admin API](#-admin-api)
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
| 👥 **Multi-Account** | Multiple GitHub accounts with automatic failover on quota exhaustion/rate limiting/bans |
| 🔀 **Model Routing** | Flexible model name mapping and per-model concurrency control |
| 📱 **Visual Management** | Web dashboard for account management, model config, and runtime stats |
| 🛡️ **Network Resilience** | 120s timeout + instant stream recovery + proxy tunnel keepalive (30s heartbeat, per-account pools) |
| ✂️ **Context Passthrough** | Full context passthrough to upstream API; clients (e.g. Claude Code) manage compression |
| 🔍 **Smart Model Matching** | Handles model name format differences (date suffixes, dash/dot versions, etc.) |
| 🧠 **Thinking Chain** | Automatically enables deep thinking for supported models, improving code quality |
| 🧹 **Reminder Stripping** | Strips client-injected reminder blocks before forwarding, avoiding upstream false-positive rejections |

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

## 👥 Multi-Account Management

New in v1.1.0. When one account's quota is exhausted, rate-limited, or banned, the system automatically and seamlessly switches to the next available account.

### Why Multi-Account?

- **Quota pooling**: Combine Copilot quotas from multiple accounts
- **High availability**: Other accounts take over when one is rate-limited or banned
- **Seamless failover**: Clients (e.g. Claude Code) need no changes — failover is transparent

### Adding Accounts

#### Option 1: CLI Command (Recommended)

Add accounts via GitHub Device Code flow — no manual token required:

```bash
# Add a new account
npx copilot-api-plus@latest add-account

# With a label
npx copilot-api-plus@latest add-account --label "Work Account"

# With account type
npx copilot-api-plus@latest add-account --label "Enterprise" --account-type business
```

A device code will be displayed. Open <https://github.com/login/device> in your browser and enter the code to authorize.

#### Option 2: Web Dashboard

After starting the server, open the Usage Viewer page and switch to the "Account Management" tab:

1. Click "Add Account"
2. Select "Device Code Authorization"
3. Complete GitHub authorization in your browser
4. The account is added automatically upon success

#### Option 3: API

If you already have a GitHub token, add it directly via the API:

```bash
curl -X POST http://localhost:4141/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"githubToken": "ghp_xxx", "label": "My Account"}'
```

### Managing Accounts

```bash
# List all accounts
npx copilot-api-plus@latest list-accounts

# Example output:
# ┌───┬──────────┬──────────┬────────┬───────────────────┐
# │ # │ Label    │ Login    │ Status │ Premium Remaining │
# ├───┼──────────┼──────────┼────────┼───────────────────┤
# │ 1 │ Primary  │ user1    │ active │ 800/1000          │
# │ 2 │ Backup   │ user2    │ active │ 950/1000          │
# └───┴──────────┴──────────┴────────┴───────────────────┘

# Remove an account (by label or index)
npx copilot-api-plus@latest remove-account "Primary"
npx copilot-api-plus@latest remove-account 1
```

### Account Selection Strategy

The system automatically selects the best account in this priority order:

1. **Filter unavailable**: Exclude disabled, banned, exhausted, and cooling-down accounts
2. **Prefer high quota**: Accounts with more remaining quota are selected first
3. **Round-robin**: When quotas are equal, the least recently used account is selected

### Account Statuses

| Status | Description | Auto-Recovery |
|--------|-------------|---------------|
| `active` | Normal, available | - |
| `exhausted` | Quota depleted | Recovers when quota resets |
| `rate_limited` | Rate-limited | Auto-retry after 60-second cooldown |
| `banned` | Token invalid/banned | Requires manual action |
| `error` | Network/other error | Auto-retry after 60-second cooldown |
| `disabled` | Manually disabled | Requires manual re-enable |

### Auto-Migration

If you were using single-account mode before, your existing account is automatically migrated to the multi-account system on first startup with v1.1.0. No action required.

---

## 🛡️ Multi-Account Anti-Correlation

New in v1.2.18. Anti-correlation measures are automatically enabled in multi-account mode to prevent GitHub from linking multiple accounts to the same user.

### Automatic (No Configuration Needed)

The following measures run **fully automatically** in multi-account mode — no user action required:

| Measure | Description |
|---------|-------------|
| **Device Fingerprint Isolation** | Each account gets a unique `vscode-machineid` (persisted to accounts.json) and `vscode-sessionid` (regenerated on every startup) |
| **Connection Pool Isolation** | Each account uses its own TCP/TLS connection pool — no shared connections |
| **Request Timing Isolation** | 1-5s random delay when switching accounts; minimum 1s interval between same-account requests |
| **Connection Pool Recycling** | Connection pools are automatically recreated every ~4 hours (±25% jitter), simulating client restarts |

### Advanced: Per-Account Proxy (Optional)

If you have multiple proxy endpoints, you can assign each account its own proxy for **exit IP isolation** — the strongest anti-correlation measure.

> Most users only have one proxy and don't need this. The automatic measures above are sufficient.

#### Configuration

Edit `~/.local/share/copilot-api-plus/accounts.json` and add a `proxy` field to each account:

```jsonc
[
  {
    "id": "...",
    "label": "Account 1",
    "githubToken": "ghu_xxx",
    "proxy": "http://127.0.0.1:7891"   // Exit via proxy A
  },
  {
    "id": "...",
    "label": "Account 2",
    "githubToken": "ghu_yyy",
    "proxy": "socks5://127.0.0.1:7892" // Exit via proxy B
  },
  {
    "id": "...",
    "label": "Account 3",
    "githubToken": "ghu_zzz"
    // No proxy = use global proxy or direct connection
  }
]
```

You can also specify the proxy when adding an account via API:

```bash
curl -X POST http://localhost:4141/admin/accounts \
  -H "Content-Type: application/json" \
  -d '{"githubToken": "ghu_xxx", "label": "Account 1", "proxy": "http://127.0.0.1:7891"}'
```

Supports `http://`, `https://`, and `socks5://` protocols. Restart the server after editing for changes to take effect.

---

## 🔀 Model Routing

New in v1.1.0. Flexible model name mapping and per-model concurrency control.

### Model Name Mapping

Map model names requested by clients to different models sent to Copilot:

```bash
# Configure mapping via API
curl -X PUT http://localhost:4141/api/models/mapping \
  -H "Content-Type: application/json" \
  -d '{"mapping": {"gpt-4": "claude-sonnet-4", "fast": "gpt-4.1-mini"}}'
```

You can also edit mappings visually in the Web dashboard under the "Model Management" tab.

#### Wildcard Mapping

Use `*` as a key to route all unmatched model names to a single model:

```bash
curl -X PUT http://localhost:4141/api/models/mapping \
  -H "Content-Type: application/json" \
  -d '{"mapping": {"*": "claude-sonnet-4"}}'
```

### Concurrency Control

Limit the maximum concurrent requests per model to prevent overload:

```bash
# Set concurrency limits
curl -X PUT http://localhost:4141/api/models/concurrency \
  -H "Content-Type: application/json" \
  -d '{"concurrency": {"claude-sonnet-4": 5, "default": 10}}'
```

- `default` is the fallback concurrency limit for unspecified models
- Requests exceeding the limit are queued, not rejected

### View Current Config

```bash
# View mapping config
curl http://localhost:4141/api/models/mapping

# View concurrency config
curl http://localhost:4141/api/models/concurrency

# View available models
curl http://localhost:4141/api/models/available
```

Mapping and concurrency settings are persisted to `config.json` and auto-loaded on restart.

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

## 🔧 opencode Integration

[opencode](https://github.com/sst/opencode) is a modern AI coding assistant.

### Configuration

1. Create `opencode.json` in your project root:

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

2. Start copilot-api-plus:

```bash
npx copilot-api-plus@latest start
```

3. In the same directory, run opencode:

```bash
npx opencode@latest
```

4. Select `copilot-api-plus` as the provider

### Shortcut: Using Environment Variables

```bash
# Set environment variables
export OPENAI_BASE_URL=http://127.0.0.1:4141/v1
export OPENAI_API_KEY=dummy

# Run opencode
npx opencode@latest
```

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
[claude-opus-4-6 thinking] 13:13:39 <-- POST /v1/messages?beta=true
[claude-opus-4-6 thinking] 13:13:59 --> POST /v1/messages?beta=true 200 20.1s
```

### Network Resilience

Built-in connection timeout and proxy tunnel keepalive for stable SSE streaming:

- **Connection timeout**: 120 seconds for response headers (thinking models may take 60–120s before streaming starts)
- **No network-layer retries**: Requests consume a Copilot credit upon reaching the server — retrying wastes credits. The caller (e.g. Claude Code) handles retry at the application level
- **Instant stream recovery**: On SSE stream interruption, immediately destroys the connection pool so the next request uses fresh connections (recovery time drops from ~135s to seconds)
- **Proxy tunnel keepalive**: Sends heartbeat requests every 30s through **each account's own connection pool** while SSE streams are active, preventing proxy nodes from killing CONNECT tunnels due to inactivity (each account is pinged independently in multi-account mode)
- SSE stream interruptions gracefully send error events to the client

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
| `add-account` | Add a new GitHub account via Device Code auth |
| `list-accounts` | List all configured accounts |
| `remove-account` | Remove an account by label or index |

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

### add-account Options

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `--label` | `-l` | - | Label for the account |
| `--account-type` | `-a` | individual | Account type (individual/business/enterprise) |
| `--verbose` | `-v` | false | Enable verbose logging |

### list-accounts Options

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `--verbose` | `-v` | false | Enable verbose logging |

### remove-account Options

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `<id>` | - | - | Account label or index (positional argument) |
| `--label` | `-l` | - | Account label |
| `--force` | `-f` | false | Skip confirmation prompt |
| `--verbose` | `-v` | false | Enable verbose logging |

---

## 📡 Admin API

New in v1.1.0. REST API for managing accounts, model configuration, and viewing runtime statistics. All endpoints are under the `/api` prefix.

### Account Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/accounts` | List all accounts (tokens masked) |
| POST | `/api/accounts` | Add an account (requires `githubToken` and `label`) |
| DELETE | `/api/accounts/:id` | Remove an account by ID |
| PUT | `/api/accounts/:id/status` | Enable/disable an account (`"active"` or `"disabled"`) |
| POST | `/api/accounts/:id/refresh` | Force refresh token and quota for an account |
| GET | `/api/accounts/usage` | Aggregated quota statistics across all accounts |

#### Device Code Auth Flow (for Web UI)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/accounts/auth/start` | Initiate GitHub Device Code flow; returns device code and verification URL |
| POST | `/api/accounts/auth/poll` | Poll authorization status (requires `device_code`); auto-adds account on success |

#### Examples

```bash
# List all accounts
curl http://localhost:4141/api/accounts

# Add an account
curl -X POST http://localhost:4141/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"githubToken": "ghp_xxx", "label": "My Account"}'

# Enable/disable an account
curl -X PUT http://localhost:4141/api/accounts/<account-id>/status \
  -H "Content-Type: application/json" \
  -d '{"status": "disabled"}'

# Force refresh an account
curl -X POST http://localhost:4141/api/accounts/<account-id>/refresh

# View aggregated quota
curl http://localhost:4141/api/accounts/usage
```

### Model Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/models/available` | List all models available from Copilot |
| GET | `/api/models/mapping` | View current model mapping config |
| PUT | `/api/models/mapping` | Update model mapping (requires `mapping` object) |
| GET | `/api/models/concurrency` | View current concurrency config |
| PUT | `/api/models/concurrency` | Update concurrency config (requires `concurrency` object, positive integers) |

#### Examples

```bash
# View available models
curl http://localhost:4141/api/models/available

# Set model mapping
curl -X PUT http://localhost:4141/api/models/mapping \
  -H "Content-Type: application/json" \
  -d '{"mapping": {"gpt-4": "claude-sonnet-4", "*": "claude-sonnet-4"}}'

# Set concurrency limits
curl -X PUT http://localhost:4141/api/models/concurrency \
  -H "Content-Type: application/json" \
  -d '{"concurrency": {"claude-sonnet-4": 5, "default": 10}}'
```

### Runtime Statistics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stats` | Runtime stats (account count, active count, model concurrency, uptime) |

```bash
curl http://localhost:4141/api/stats
# Returns: {"accounts":{"total":2,"active":2},"models":{...},"uptime":3600}
```

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
| `config.json` | Proxy, model mapping, concurrency settings |
| `accounts.json` | Multi-account data (tokens, status, quotas) |

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
