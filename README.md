# Copilot API Plus



> **Fork of [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)** with bug fixes and improvements.

> [!WARNING]
> This is a reverse-engineered proxy of GitHub Copilot API. It is not supported by GitHub, and may break unexpectedly. Use at your own risk.

> [!WARNING]
> **GitHub Security Notice:**  
> Excessive automated or scripted use of Copilot (including rapid or bulk requests, such as via automated tools) may trigger GitHub's abuse-detection systems.  
> You may receive a warning from GitHub Security, and further anomalous activity could result in temporary suspension of your Copilot access.
>
> GitHub prohibits use of their servers for excessive automated bulk activity or any activity that places undue burden on their infrastructure.
>
> Please review:
>
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
>
> Use this proxy responsibly to avoid account restrictions.

---

## What's Different from Original?

This fork includes the following bug fixes and improvements:

- ✅ **Auto Re-authentication**: Automatically detects invalid/expired GitHub tokens and re-authenticates
- ✅ **Logout Command**: New `logout` command to clear stored tokens and switch accounts
- ✅ **Better Error Handling**: Token refresh failures no longer crash the server
- ✅ **OAuth Timeout**: Device code polling now has proper timeout handling
- ✅ **Token Validation**: Validates provided GitHub tokens before use
- ✅ **API Key Auth**: API key authentication middleware is now properly enabled

---

## Project Overview

A reverse-engineered proxy for the GitHub Copilot API that exposes it as an OpenAI and Anthropic compatible service. This allows you to use GitHub Copilot with any tool that supports the OpenAI Chat Completions API or the Anthropic Messages API, including to power [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

## Features

- **OpenAI & Anthropic Compatibility**: Exposes GitHub Copilot as an OpenAI-compatible (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) and Anthropic-compatible (`/v1/messages`) API.
- **Claude Code Integration**: Easily configure and launch [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) to use Copilot as its backend with a simple command-line flag (`--claude-code`).
- **Usage Dashboard**: A web-based dashboard to monitor your Copilot API usage, view quotas, and see detailed statistics.
- **Rate Limit Control**: Manage API usage with rate-limiting options (`--rate-limit`) and a waiting mechanism (`--wait`) to prevent errors from rapid requests.
- **Manual Request Approval**: Manually approve or deny each API request for fine-grained control over usage (`--manual`).
- **Token Visibility**: Option to display GitHub and Copilot tokens during authentication and refresh for debugging (`--show-token`).
- **Flexible Authentication**: Authenticate interactively or provide a GitHub token directly, suitable for CI/CD environments.
- **Support for Different Account Types**: Works with individual, business, and enterprise GitHub Copilot plans.

## Prerequisites

- Bun (>= 1.2.x)
- GitHub account with Copilot subscription (individual, business, or enterprise)

## Installation

To install dependencies, run:

```sh
bun install
```

## Using with Docker

Build image

```sh
docker build -t copilot-api-plus .
```

Run the container

```sh
# Create a directory on your host to persist the GitHub token and related data
mkdir -p ./copilot-data

# Run the container with a bind mount to persist the token
# This ensures your authentication survives container restarts

docker run -p 4141:4141 -v $(pwd)/copilot-data:/root/.local/share/copilot-api-plus copilot-api-plus
```

> **Note:**
> The GitHub token and related data will be stored in `copilot-data` on your host. This is mapped to `/root/.local/share/copilot-api-plus` inside the container, ensuring persistence across restarts.

### Docker with Environment Variables

You can pass the GitHub token directly to the container using environment variables:

```sh
# Build with GitHub token
docker build --build-arg GH_TOKEN=your_github_token_here -t copilot-api-plus .

# Run with GitHub token
docker run -p 4141:4141 -e GH_TOKEN=your_github_token_here copilot-api-plus

# Run with additional options
docker run -p 4141:4141 -e GH_TOKEN=your_token copilot-api-plus start --verbose --port 4141
```

### Docker Compose Example

```yaml
version: "3.8"
services:
  copilot-api-plus:
    build: .
    ports:
      - "4141:4141"
    environment:
      - GH_TOKEN=your_github_token_here
    restart: unless-stopped
```

The Docker image includes:

- Multi-stage build for optimized image size
- Non-root user for enhanced security
- Health check for container monitoring
- Pinned base image version for reproducible builds

## Using with npx

You can run the project directly using npx:

```sh
npx copilot-api-plus@latest start
```

With options:

```sh
npx copilot-api-plus@latest start --port 8080
```

For authentication only:

```sh
npx copilot-api-plus@latest auth
```

## Command Structure

Copilot API Plus uses a subcommand structure with these main commands:

- `start`: Start the Copilot API server. This command will also handle authentication if needed.
- `auth`: Run GitHub authentication flow without starting the server. This is typically used if you need to generate a token for use with the `--github-token` option, especially in non-interactive environments.
- `check-usage`: Show your current GitHub Copilot usage and quota information directly in the terminal (no server required).
- `debug`: Display diagnostic information including version, runtime details, file paths, and authentication status. Useful for troubleshooting and support.
- `logout`: Clear stored GitHub token and logout. Use this to switch accounts or re-authenticate.

## Command Line Options

### Start Command Options

The following command line options are available for the `start` command:

| Option         | Description                                                                   | Default    | Alias |
| -------------- | ----------------------------------------------------------------------------- | ---------- | ----- |
| --port         | Port to listen on                                                             | 4141       | -p    |
| --verbose      | Enable verbose logging                                                        | false      | -v    |
| --account-type | Account type to use (individual, business, enterprise)                        | individual | -a    |
| --manual       | Enable manual request approval                                                | false      | none  |
| --rate-limit   | Rate limit in seconds between requests                                        | none       | -r    |
| --wait         | Wait instead of error when rate limit is hit                                  | false      | -w    |
| --github-token | Provide GitHub token directly (must be generated using the `auth` subcommand) | none       | -g    |
| --claude-code  | Generate a command to launch Claude Code with Copilot API config              | false      | -c    |
| --show-token   | Show GitHub and Copilot tokens on fetch and refresh                           | false      | none  |
| --proxy-env    | Initialize proxy from environment variables                                   | false      | none  |
| --zen          | Enable OpenCode Zen mode (proxy to Zen instead of GitHub Copilot)             | false      | -z    |
| --zen-api-key  | OpenCode Zen API key (get from https://opencode.ai/zen)                       | none       | none  |

### Auth Command Options

| Option       | Description               | Default | Alias |
| ------------ | ------------------------- | ------- | ----- |
| --verbose    | Enable verbose logging    | false   | -v    |
| --show-token | Show GitHub token on auth | false   | none  |

### Debug Command Options

| Option | Description               | Default | Alias |
| ------ | ------------------------- | ------- | ----- |
| --json | Output debug info as JSON | false   | none  |

## Proxy Configuration

If you are behind a corporate firewall or need to route traffic through a proxy server, you can configure the proxy using environment variables.

### Using the `--proxy-env` Flag

Start the server with the `--proxy-env` flag to automatically read proxy settings from environment variables:

```sh
# Set proxy environment variables first
export HTTP_PROXY=http://your-proxy-server:8080
export HTTPS_PROXY=http://your-proxy-server:8080

# Start with proxy support
npx copilot-api-plus@latest start --proxy-env
```

On Windows (PowerShell):

```powershell
$env:HTTP_PROXY = "http://your-proxy-server:8080"
$env:HTTPS_PROXY = "http://your-proxy-server:8080"
npx copilot-api-plus@latest start --proxy-env
```

On Windows (CMD):

```cmd
set HTTP_PROXY=http://your-proxy-server:8080
set HTTPS_PROXY=http://your-proxy-server:8080
npx copilot-api-plus@latest start --proxy-env
```

### Supported Proxy Environment Variables

| Variable      | Description                               |
| ------------- | ----------------------------------------- |
| `HTTP_PROXY`  | Proxy URL for HTTP connections            |
| `HTTPS_PROXY` | Proxy URL for HTTPS connections           |
| `http_proxy`  | Alternative (lowercase) for HTTP proxy    |
| `https_proxy` | Alternative (lowercase) for HTTPS proxy   |
| `NO_PROXY`    | Comma-separated list of hosts to bypass   |
| `no_proxy`    | Alternative (lowercase) for no-proxy list |

### Proxy Authentication

If your proxy requires authentication, include the credentials in the URL:

```sh
export HTTPS_PROXY=http://username:password@your-proxy-server:8080
```

### Docker with Proxy

When running in Docker, pass the proxy environment variables:

```sh
docker run -p 4141:4141 \
  -e HTTP_PROXY=http://your-proxy:8080 \
  -e HTTPS_PROXY=http://your-proxy:8080 \
  copilot-api-plus start --proxy-env
```

## API Endpoints

The server exposes several endpoints to interact with the Copilot API. It provides OpenAI-compatible endpoints and now also includes support for Anthropic-compatible endpoints, allowing for greater flexibility with different tools and services.

### OpenAI Compatible Endpoints

These endpoints mimic the OpenAI API structure.

| Endpoint                    | Method | Description                                               |
| --------------------------- | ------ | --------------------------------------------------------- |
| `POST /v1/chat/completions` | `POST` | Creates a model response for the given chat conversation. |
| `GET /v1/models`            | `GET`  | Lists the currently available models.                     |
| `POST /v1/embeddings`       | `POST` | Creates an embedding vector representing the input text.  |

### Anthropic Compatible Endpoints

These endpoints are designed to be compatible with the Anthropic Messages API.

| Endpoint                         | Method | Description                                                  |
| -------------------------------- | ------ | ------------------------------------------------------------ |
| `POST /v1/messages`              | `POST` | Creates a model response for a given conversation.           |
| `POST /v1/messages/count_tokens` | `POST` | Calculates the number of tokens for a given set of messages. |

### Usage Monitoring Endpoints

New endpoints for monitoring your Copilot usage and quotas.

| Endpoint     | Method | Description                                                  |
| ------------ | ------ | ------------------------------------------------------------ |
| `GET /usage` | `GET`  | Get detailed Copilot usage statistics and quota information. |
| `GET /token` | `GET`  | Get the current Copilot token being used by the API.         |

## Example Usage

Using with npx:

```sh
# Basic usage with start command
npx copilot-api-plus@latest start

# Run on custom port with verbose logging
npx copilot-api-plus@latest start --port 8080 --verbose

# Use with a business plan GitHub account
npx copilot-api-plus@latest start --account-type business

# Use with an enterprise plan GitHub account
npx copilot-api-plus@latest start --account-type enterprise

# Enable manual approval for each request
npx copilot-api-plus@latest start --manual

# Set rate limit to 30 seconds between requests
npx copilot-api-plus@latest start --rate-limit 30

# Wait instead of error when rate limit is hit
npx copilot-api-plus@latest start --rate-limit 30 --wait

# Provide GitHub token directly
npx copilot-api-plus@latest start --github-token ghp_YOUR_TOKEN_HERE

# Run only the auth flow
npx copilot-api-plus@latest auth

# Run auth flow with verbose logging
npx copilot-api-plus@latest auth --verbose

# Show your Copilot usage/quota in the terminal (no server needed)
npx copilot-api-plus@latest check-usage

# Display debug information for troubleshooting
npx copilot-api-plus@latest debug

# Display debug information in JSON format
npx copilot-api-plus@latest debug --json

# Logout and clear stored tokens (to switch accounts)
npx copilot-api-plus@latest logout

# Initialize proxy from environment variables (HTTP_PROXY, HTTPS_PROXY, etc.)
npx copilot-api-plus@latest start --proxy-env
```

## Using the Usage Viewer

After starting the server, a URL to the Copilot Usage Dashboard will be displayed in your console. This dashboard is a web interface for monitoring your API usage.

1.  Start the server. For example, using npx:
    ```sh
    npx copilot-api-plus@latest start
    ```
2.  The server will output a URL to the usage viewer. Copy and paste this URL into your browser. It will look something like this:
    `https://imbuxiangnan-cyber.github.io/copilot-api-plus?endpoint=http://localhost:4141/usage`
    - If you use the `start.bat` script on Windows, this page will open automatically.

The dashboard provides a user-friendly interface to view your Copilot usage data:

- **API Endpoint URL**: The dashboard is pre-configured to fetch data from your local server endpoint via the URL query parameter. You can change this URL to point to any other compatible API endpoint.
- **Fetch Data**: Click the "Fetch" button to load or refresh the usage data. The dashboard will automatically fetch data on load.
- **Usage Quotas**: View a summary of your usage quotas for different services like Chat and Completions, displayed with progress bars for a quick overview.
- **Detailed Information**: See the full JSON response from the API for a detailed breakdown of all available usage statistics.
- **URL-based Configuration**: You can also specify the API endpoint directly in the URL using a query parameter. This is useful for bookmarks or sharing links. For example:
  `https://imbuxiangnan-cyber.github.io/copilot-api-plus?endpoint=http://your-api-server/usage`

## Using with OpenCode Zen


### OpenCode Zen 使用指南

OpenCode Zen 是由 opencode.ai 提供的多模型 API 服务，支持 Claude、GPT-5、Gemini、Qwen 等主流大模型，适合代码生成、AI 助手等场景。Copilot API Plus 支持将 Zen 转换为 OpenAI/Anthropic 兼容 API，方便与 Claude Code、opencode 等工具无缝集成。

#### 1. 获取 Zen API Key
1. 访问 [https://opencode.ai/zen](https://opencode.ai/zen)
2. 注册并登录，进入“API Keys”页面，创建你的 API Key

#### 2. 启动 Zen 模式
首次运行会自动提示输入 API Key，并保存到本地。也可直接指定：
```sh
npx copilot-api-plus@latest start --zen --zen-api-key <你的APIKey>
```
或交互式：
```sh
npx copilot-api-plus@latest start --zen
```

#### 3. 与 Claude Code 配合
Zen 支持多种 Claude 模型，推荐用法：
```sh
npx copilot-api-plus@latest start --zen --claude-code
```
会自动生成 Claude Code 启动命令，支持模型选择。

#### 4. 支持的模型（部分示例）
| 名称                | ID                   | 说明                      |
|---------------------|----------------------|---------------------------|
| Claude Sonnet 4.5   | claude-sonnet-4-5    | Anthropic Claude 200K     |
| Claude Opus 4.5     | claude-opus-4-5      | Anthropic Claude 200K     |
| GPT-5 Codex         | gpt-5-codex          | OpenAI Responses API      |
| Gemini 3 Pro        | gemini-3-pro         | Google Gemini             |
| Qwen3 Coder 480B    | qwen3-coder          | Alibaba Qwen              |
| Kimi K2             | kimi-k2              | Moonshot                  |
| Grok Code Fast 1    | grok-code            | xAI                       |
更多模型请见 [Zen 官网](https://opencode.ai/zen)。

#### 5. API 路径
Zen 模式下，所有 OpenAI/Anthropic 兼容路径均可用：
- `POST /v1/chat/completions`  （OpenAI 格式）
- `POST /v1/messages`          （Anthropic 格式）
- `GET /v1/models`             （模型列表）
Zen 专属路径（始终可用）：
- `POST /zen/v1/chat/completions`
- `POST /zen/v1/messages`
- `GET /zen/v1/models`

#### 6. 常见问题
- **API Key 存储位置**：`~/.local/share/copilot-api-plus/zen-auth.json`
- **切换/清除 API Key**：
  - 只清除 Zen：`npx copilot-api-plus@latest logout --zen`
  - 全部清除：`npx copilot-api-plus@latest logout --all`
- **模型选择**：启动时会自动显示可用模型列表
- **与 opencode 配合**：在 `opencode.json` 里设置 `baseURL` 为 `http://127.0.0.1:4141/v1`，或用环境变量 `OPENAI_BASE_URL`

#### 7. 使用技巧
- 推荐用 `--claude-code` 生成 Claude Code 启动命令
- 支持所有 Zen 公开模型，按需选择
- 支持 Docker 部署，API Key 持久化

如需详细配置示例、opencode 配置、更多高级用法，请继续阅读下方文档。

### Why Use Zen Mode?

- **Access to many models**: Claude Sonnet 4.5, Claude Opus 4.5, GPT-5 Codex, Gemini 3 Pro, Qwen3 Coder, and more
- **Transparent pricing**: Pay per request with zero markups
- **Tested & verified**: All models are tested by the OpenCode team for coding tasks
- **Single API key**: One key for all Zen models

### Getting Started with Zen

1. **Get your API key**: Go to [opencode.ai/zen](https://opencode.ai/zen), sign up, and create an API key.

2. **Start the server in Zen mode**:
   ```sh
   npx copilot-api-plus@latest start --zen
   ```
   
   You will be prompted to enter your Zen API key on first run. The key will be saved for future use.

3. **Or provide the API key directly**:
   ```sh
   npx copilot-api-plus@latest start --zen --zen-api-key your_api_key_here
   ```

### Using Zen with Claude Code

Start the server with both `--zen` and `--claude-code` flags:

```sh
npx copilot-api-plus@latest start --zen --claude-code
```

This will:
1. Connect to OpenCode Zen instead of GitHub Copilot
2. Show you available Zen models to choose from
3. Generate a command to launch Claude Code with the selected model

### Available Zen Models

When using Zen mode, you can access models like:

| Model              | ID                | Description                    |
| ------------------ | ----------------- | ------------------------------ |
| Claude Sonnet 4.5  | claude-sonnet-4-5 | Anthropic Claude (200K context)|
| Claude Opus 4.5    | claude-opus-4-5   | Anthropic Claude (200K context)|
| GPT 5 Codex        | gpt-5-codex       | OpenAI (Responses API)         |
| Gemini 3 Pro       | gemini-3-pro      | Google Gemini                  |
| Qwen3 Coder 480B   | qwen3-coder       | Alibaba Qwen                   |
| Kimi K2            | kimi-k2           | Moonshot                       |
| Grok Code Fast 1   | grok-code         | xAI                            |

For the full list, visit [opencode.ai/zen](https://opencode.ai/zen).

### Zen API Endpoints

The server exposes the same endpoints in Zen mode:

| Endpoint                    | Description                          |
| --------------------------- | ------------------------------------ |
| `POST /v1/chat/completions` | OpenAI-compatible chat completions   |
| `POST /v1/messages`         | Anthropic-compatible messages        |
| `GET /v1/models`            | List available Zen models            |

You can also access dedicated Zen routes (always available):

| Endpoint                         | Description              |
| -------------------------------- | ------------------------ |
| `POST /zen/v1/chat/completions`  | Zen chat completions     |
| `POST /zen/v1/messages`          | Zen messages             |
| `GET /zen/v1/models`             | Zen models               |

## Using with Claude Code

This proxy can be used to power [Claude Code](https://docs.anthropic.com/en/claude-code), an experimental conversational AI assistant for developers from Anthropic.

There are two ways to configure Claude Code to use this proxy:

### Interactive Setup with `--claude-code` flag

To get started, run the `start` command with the `--claude-code` flag:

```sh
npx copilot-api-plus@latest start --claude-code
```

You will be prompted to select a primary model and a "small, fast" model for background tasks. After selecting the models, a command will be copied to your clipboard. This command sets the necessary environment variables for Claude Code to use the proxy.

Paste and run this command in a new terminal to launch Claude Code.

### Manual Configuration with `settings.json`

Alternatively, you can configure Claude Code by creating a `.claude/settings.json` file in your project's root directory. This file should contain the environment variables needed by Claude Code. This way you don't need to run the interactive setup every time.

Here is an example `.claude/settings.json` file:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "deny": [
      "WebSearch"
    ]
  }
}
```

You can find more options here: [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

You can also read more about IDE integration here: [Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

## Using with opencode

[opencode](https://github.com/sst/opencode) is a modern AI coding assistant that supports multiple providers. You can use copilot-api-plus as a custom provider for opencode.

### Configuration

Create or edit `opencode.json` in your project root directory:

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
          "default_tokens": 16000,
          "profile": "coder",
          "attachment": true,
          "limit": {
            "context": 200000
          }
        },
        "claude-sonnet-4.5": {
          "name": "Claude Sonnet 4.5",
          "id": "claude-sonnet-4.5",
          "max_tokens": 64000,
          "default_tokens": 16000,
          "profile": "coder",
          "attachment": true,
          "limit": {
            "context": 200000
          }
        },
        "gpt-4.1": {
          "name": "GPT-4.1",
          "id": "gpt-4.1",
          "max_tokens": 32768,
          "default_tokens": 16000,
          "profile": "coder",
          "attachment": true,
          "limit": {
            "context": 1047576
          }
        },
        "o4-mini": {
          "name": "o4-mini",
          "id": "o4-mini",
          "max_tokens": 100000,
          "default_tokens": 16000,
          "profile": "coder",
          "attachment": true,
          "limit": {
            "context": 200000
          }
        },
        "gemini-2.5-pro": {
          "name": "Gemini 2.5 Pro",
          "id": "gemini-2.5-pro",
          "max_tokens": 65536,
          "default_tokens": 16000,
          "profile": "coder",
          "attachment": true,
          "limit": {
            "context": 1048576
          }
        }
      }
    }
  }
}
```

### Usage

1. Start copilot-api-plus:
   ```sh
   npx copilot-api-plus@latest start --proxy-env
   ```

2. Run opencode in the same project directory:
   ```sh
   npx opencode@latest
   ```

3. Select `copilot-api-plus` as your provider when prompted, or use the model switcher to change providers.

### Available Models

When using copilot-api-plus with opencode, you can access all GitHub Copilot models:

| Model             | Description                          |
| ----------------- | ------------------------------------ |
| `claude-sonnet-4` | Claude Sonnet 4 (200K context)       |
| `claude-sonnet-4.5` | Claude Sonnet 4.5 (200K context)   |
| `gpt-4.1`         | GPT-4.1 (1M context)                 |
| `o4-mini`         | OpenAI o4-mini reasoning model       |
| `gemini-2.5-pro`  | Google Gemini 2.5 Pro (1M context)   |

### Environment Variables for opencode

If you prefer not to create a config file, you can also set environment variables:

```sh
# Set the base URL for opencode to use
export OPENAI_BASE_URL=http://127.0.0.1:4141/v1
export OPENAI_API_KEY=dummy

# Start opencode
npx opencode@latest
```

## Running from Source

The project can be run from source in several ways:

### Development Mode

```sh
bun run dev
```

### Production Mode

```sh
bun run start
```

## Usage Tips

- To avoid hitting GitHub Copilot's rate limits, you can use the following flags:
  - `--manual`: Enables manual approval for each request, giving you full control over when requests are sent.
  - `--rate-limit <seconds>`: Enforces a minimum time interval between requests. For example, `copilot-api start --rate-limit 30` will ensure there's at least a 30-second gap between requests.
  - `--wait`: Use this with `--rate-limit`. It makes the server wait for the cooldown period to end instead of rejecting the request with an error. This is useful for clients that don't automatically retry on rate limit errors.
- If you have a GitHub business or enterprise plan account with Copilot, use the `--account-type` flag (e.g., `--account-type business`). See the [official documentation](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization) for more details.
