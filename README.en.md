# Copilot API Plus

[![npm version](https://img.shields.io/npm/v/copilot-api-plus.svg)](https://www.npmjs.com/package/copilot-api-plus)
[![license](https://img.shields.io/npm/l/copilot-api-plus.svg)](https://github.com/imbuxiangnan-cyber/copilot-api-plus/blob/main/LICENSE)

English | [简体中文](README.md)

> A proxy that converts GitHub Copilot, OpenCode Zen, and Google Antigravity into OpenAI & Anthropic compatible APIs. Works with Claude Code, opencode, and more.

---

## 📋 Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
- [Usage Guide](#-usage-guide)
  - [GitHub Copilot Mode](#1-github-copilot-mode-default)
  - [OpenCode Zen Mode](#2-opencode-zen-mode)
  - [Google Antigravity Mode](#3-google-antigravity-mode)
- [Proxy Configuration](#-proxy-configuration)
- [Claude Code Integration](#-claude-code-integration)
- [opencode Integration](#-opencode-integration)
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
| 🔌 **Multiple Backends** | Choose from GitHub Copilot, OpenCode Zen, or Google Antigravity |
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
| 🔁 **Antigravity Failover** | Dual-endpoint auto-switching with per-model-family rate tracking and exponential backoff |

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

# Use OpenCode Zen
npx copilot-api-plus@latest start --zen

# Use Google Antigravity
npx copilot-api-plus@latest start --antigravity

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

### 2. OpenCode Zen Mode

Use [OpenCode Zen](https://opencode.ai/zen)'s multi-model API service, supporting GPT-5, Claude, Gemini, and other top coding models.

#### Prerequisites
1. Visit https://opencode.ai/zen
2. Register and create an API Key

#### Getting Started

**Option 1: Interactive setup**
```bash
npx copilot-api-plus@latest start --zen
```
First run will prompt for an API Key, which is saved for future use.

**Option 2: Provide API Key directly**
```bash
npx copilot-api-plus@latest start --zen --zen-api-key YOUR_API_KEY
```

#### Available Models

| Model | ID | Description |
|-------|-----|-------------|
| GPT-5.2 | `gpt-5.2` | OpenAI latest |
| GPT-5.1 Codex Max | `gpt-5.1-codex-max` | Code-optimized |
| GPT-5.1 Codex | `gpt-5.1-codex` | Code-focused |
| GPT-5 Codex | `gpt-5-codex` | OpenAI Responses API |
| Claude Opus 4.5 | `claude-opus-4-5` | Anthropic Claude (200K) |
| Claude Sonnet 4.5 | `claude-sonnet-4-5` | Anthropic Claude (200K) |
| Claude Sonnet 4 | `claude-sonnet-4` | Anthropic Claude |
| Gemini 3 Pro | `gemini-3-pro` | Google Gemini |
| Qwen3 Coder | `qwen3-coder` | Alibaba Qwen |
| Kimi K2 | `kimi-k2` | Moonshot |
| Grok Code Fast 1 | `grok-code-fast-1` | xAI |

More models at [opencode.ai/zen](https://opencode.ai/zen)

#### API Endpoints

Zen mode supports the following endpoints:

| Endpoint | Description |
|----------|-------------|
| `/v1/chat/completions` | OpenAI-compatible Chat API |
| `/v1/messages` | Anthropic-compatible Messages API |
| `/v1/responses` | OpenAI Responses API (GPT-5 series) |
| `/v1/models` | List available models |

Dedicated endpoints (accessible without `--zen` flag):
- `/zen/v1/chat/completions`
- `/zen/v1/messages`
- `/zen/v1/responses`
- `/zen/v1/models`

#### Manage API Key

```bash
# View/change API Key (clearing it will prompt for a new one on next start)
npx copilot-api-plus@latest logout --zen
```

---

### 3. Google Antigravity Mode

Use Google Antigravity API service, supporting Gemini and Claude models.

#### Prerequisites
- Google account

#### Authentication Methods

**Option 1: API Key (Recommended - Simplest)**

1. Get an API Key at https://aistudio.google.com/apikey
2. Start with environment variable:

```bash
# Linux/macOS
GEMINI_API_KEY=your_api_key npx copilot-api-plus@latest start --antigravity

# Windows PowerShell
$env:GEMINI_API_KEY = "your_api_key"
npx copilot-api-plus@latest start --antigravity

# Windows CMD
set GEMINI_API_KEY=your_api_key
npx copilot-api-plus@latest start --antigravity
```

**Option 2: OAuth Web Login (Recommended)**

```bash
npx copilot-api-plus@latest start --antigravity
```

First run will prompt you to choose a login method:
- **Web (Recommended)**: Opens browser for Google login, automatically captures the callback
- **Manual**: Manually copy the callback URL to the terminal

**Option 3: Custom OAuth Credentials**

If you encounter an `invalid_client` error, create your own OAuth app:

1. Visit https://console.cloud.google.com/apis/credentials
2. Create an OAuth 2.0 Client ID (select "Desktop application" type)
3. Add redirect URI: `http://localhost:8046/callback`
4. Use environment variables or CLI arguments:

```bash
# Environment variables
ANTIGRAVITY_CLIENT_ID=your_client_id ANTIGRAVITY_CLIENT_SECRET=your_secret \
  npx copilot-api-plus@latest start --antigravity

# CLI arguments
npx copilot-api-plus@latest start --antigravity \
  --antigravity-client-id your_client_id \
  --antigravity-client-secret your_secret
```

#### Available Models

| Model | ID | Description |
|-------|-----|-------------|
| Gemini 2.5 Pro | `gemini-2.5-pro-exp-03-25` | Google Gemini |
| Gemini 2.5 Pro Preview | `gemini-2.5-pro-preview-05-06` | Google Gemini |
| Gemini 2.0 Flash | `gemini-2.0-flash-exp` | Fast responses |
| Gemini 2.0 Flash Thinking | `gemini-2.0-flash-thinking-exp` | Chain-of-thought |
| Claude Opus 4.5 | `claude-opus-4-5` | Anthropic Claude |
| Claude Sonnet 4.5 | `claude-sonnet-4-5` | Anthropic Claude |

#### Features
- ✅ Automatic token refresh
- ✅ Multi-account support with auto-rotation
- ✅ Auto-switch on quota exhaustion
- ✅ Thinking model support (chain-of-thought output)

#### Multi-Account Management

Add multiple Google accounts; the system auto-switches when quota is exhausted:

```bash
# Add new account
npx copilot-api-plus@latest antigravity add

# List all accounts
npx copilot-api-plus@latest antigravity list

# Remove account by index
npx copilot-api-plus@latest antigravity remove 0

# Clear all accounts
npx copilot-api-plus@latest antigravity clear
# Or use logout
npx copilot-api-plus@latest logout --antigravity
```

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
# Using GitHub Copilot as backend
npx copilot-api-plus@latest start --claude-code

# Using OpenCode Zen as backend
npx copilot-api-plus@latest start --zen --claude-code

# Using Google Antigravity as backend
npx copilot-api-plus@latest start --antigravity --claude-code
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

### Setup

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

3. Run opencode in the same directory:
```bash
npx opencode@latest
```

4. Select `copilot-api-plus` as the provider

### Shortcut: Environment Variables

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

Each backend has its own dedicated routes, accessible regardless of the default backend:

| Route Prefix | Description |
|--------------|-------------|
| `/copilot/v1/*` | GitHub Copilot |
| `/zen/v1/*` | OpenCode Zen |
| `/antigravity/v1/*` | Google Antigravity |

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

### Antigravity Endpoint Failover

Google Antigravity mode has built-in reliability features:

- **Dual-endpoint auto-switching**: Daily sandbox and production endpoints; automatically switches on failure
- **Per-model-family rate tracking**: Separate rate limit tracking for Gemini and Claude model families
- **Exponential backoff retry**: Auto-retry on 429/503 errors; short intervals stay on the same endpoint, longer intervals switch endpoints

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
| `antigravity` | Manage Google Antigravity accounts |
| `check-usage` | View Copilot usage |
| `debug` | Show debug information |

### start Options

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `--port` | `-p` | 4141 | Listen port |
| `--verbose` | `-v` | false | Verbose logging |
| `--account-type` | `-a` | individual | Account type (individual/business/enterprise) |
| `--claude-code` | `-c` | false | Generate Claude Code launch command |
| `--zen` | `-z` | false | Enable OpenCode Zen mode |
| `--zen-api-key` | - | - | Zen API Key |
| `--antigravity` | - | false | Enable Google Antigravity mode |
| `--antigravity-client-id` | - | - | Antigravity OAuth Client ID |
| `--antigravity-client-secret` | - | - | Antigravity OAuth Client Secret |
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
| `--zen` | `-z` | Clear Zen credentials only |
| `--antigravity` | - | Clear Antigravity credentials only |
| `--all` | `-a` | Clear all credentials |

> **Tip**: Running `logout` without arguments shows an interactive menu.

### antigravity Subcommands

| Subcommand | Description |
|------------|-------------|
| `add` | Add a new Antigravity account (OAuth login) |
| `list` | List all configured accounts and their status |
| `remove <index>` | Remove account by index |
| `clear` | Clear all Antigravity accounts (requires confirmation) |

```bash
# Examples
npx copilot-api-plus@latest antigravity add      # Add account
npx copilot-api-plus@latest antigravity list     # List accounts
npx copilot-api-plus@latest antigravity remove 0 # Remove account at index 0
npx copilot-api-plus@latest antigravity clear    # Clear all accounts
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
| `zen-auth.json` | Zen API Key |
| `antigravity-accounts.json` | Antigravity accounts |
| `config.json` | Proxy and other settings |

### Switching Accounts

```bash
# Interactive credential selection
npx copilot-api-plus@latest logout

# Clear GitHub Copilot credentials only
npx copilot-api-plus@latest logout --github
# Or shorthand
npx copilot-api-plus@latest logout -g

# Clear Zen credentials
npx copilot-api-plus@latest logout --zen

# Clear Antigravity credentials
npx copilot-api-plus@latest logout --antigravity

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
