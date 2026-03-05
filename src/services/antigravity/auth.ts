/**
 * Google Antigravity Authentication
 *
 * Handles OAuth token management for Google Antigravity API.
 * Supports multiple accounts with auto-rotation and token refresh.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unnecessary-condition */

import consola from "consola"

import { PATHS, ensurePaths } from "~/lib/paths"

export interface AntigravityAccount {
  access_token: string
  refresh_token: string
  expires_in: number
  timestamp: number
  enable: boolean
  project_id?: string
}

export interface AntigravityAuth {
  accounts: Array<AntigravityAccount>
  currentIndex: number
}

const ANTIGRAVITY_AUTH_FILENAME = "antigravity-accounts.json"

// ============================================
// Authentication Methods (choose one):
// ============================================
//
// Method 1: API Key (Recommended - Simplest)
//   Set environment variable: GEMINI_API_KEY
//   Get your API key from: https://aistudio.google.com/apikey
//
// Method 2: OAuth Credentials
//   Set environment variables:
//     ANTIGRAVITY_CLIENT_ID - Google OAuth Client ID
//     ANTIGRAVITY_CLIENT_SECRET - Google OAuth Client Secret
//
//   If you get "invalid_client" error, create your own OAuth app:
//   1. Go to https://console.cloud.google.com/apis/credentials
//   2. Create OAuth 2.0 Client ID (Desktop app or Web app type)
//   3. Add redirect URI: http://localhost:8046/callback
//   4. Set environment variables with your credentials
// ============================================

// API Key authentication (simplest method)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""

/**
 * Check if API Key authentication is available
 */
export function hasApiKey(): boolean {
  return GEMINI_API_KEY.length > 0
}

/**
 * Get API Key for authentication
 */
export function getApiKey(): string | null {
  return GEMINI_API_KEY || null
}

// Default OAuth credentials (from reference projects: gcli2api, antigravity2api-nodejs, Antigravity-Manager)
const DEFAULT_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const DEFAULT_CLIENT_SECRET = "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"

// OAuth credentials - can be set via env, CLI, or defaults
let GOOGLE_CLIENT_ID = process.env.ANTIGRAVITY_CLIENT_ID || DEFAULT_CLIENT_ID
let GOOGLE_CLIENT_SECRET =
  process.env.ANTIGRAVITY_CLIENT_SECRET || DEFAULT_CLIENT_SECRET
const GOOGLE_REDIRECT_URI = "http://localhost:8046/callback"

// OAuth scopes required for Antigravity API access
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
]

/**
 * Set OAuth credentials from CLI arguments
 * This overrides environment variables and defaults
 */
export function setOAuthCredentials(
  clientId: string,
  clientSecret: string,
): void {
  GOOGLE_CLIENT_ID = clientId
  GOOGLE_CLIENT_SECRET = clientSecret
}

/**
 * Get the path to the Antigravity auth file
 */
export function getAntigravityAuthPath(): string {
  return `${PATHS.DATA_DIR}/${ANTIGRAVITY_AUTH_FILENAME}`
}

/**
 * Save Antigravity accounts to file
 */
export async function saveAntigravityAuth(
  auth: AntigravityAuth,
): Promise<void> {
  await ensurePaths()
  const authPath = getAntigravityAuthPath()
  const fs = await import("node:fs/promises")
  await fs.writeFile(authPath, JSON.stringify(auth, null, 2), "utf8")
  consola.success("Antigravity accounts saved to", authPath)
}

/**
 * Load Antigravity accounts from file
 */
export async function loadAntigravityAuth(): Promise<AntigravityAuth | null> {
  try {
    const authPath = getAntigravityAuthPath()
    const fs = await import("node:fs/promises")

    // Check if file exists
    try {
      await fs.access(authPath)
    } catch {
      return null
    }

    const content = await fs.readFile(authPath)
    const data = JSON.parse(content)

    // Handle both array format (legacy) and object format
    if (Array.isArray(data)) {
      return {
        accounts: data,
        currentIndex: 0,
      }
    }

    return data as AntigravityAuth
  } catch {
    return null
  }
}

/**
 * Clear Antigravity accounts
 */
export async function clearAntigravityAuth(): Promise<void> {
  try {
    const authPath = getAntigravityAuthPath()
    const fs = await import("node:fs/promises")
    await fs.unlink(authPath)
    consola.success("Antigravity accounts cleared")
  } catch {
    // File might not exist, ignore
  }
}

/**
 * Add a new account to Antigravity auth
 */
export async function addAntigravityAccount(
  account: AntigravityAccount,
): Promise<void> {
  let auth = await loadAntigravityAuth()

  if (!auth) {
    auth = {
      accounts: [],
      currentIndex: 0,
    }
  }

  auth.accounts.push(account)
  await saveAntigravityAuth(auth)
  consola.success("Added new Antigravity account")
}

/**
 * Get the current active account
 */
export async function getCurrentAccount(): Promise<AntigravityAccount | null> {
  const auth = await loadAntigravityAuth()

  if (!auth || auth.accounts.length === 0) {
    return null
  }

  // Find enabled account starting from current index
  const enabledAccounts = auth.accounts.filter((a) => a.enable)

  if (enabledAccounts.length === 0) {
    return null
  }

  // Get current account or first enabled one
  const currentAccount = auth.accounts[auth.currentIndex]
  if (currentAccount && currentAccount.enable) {
    return currentAccount
  }

  return enabledAccounts[0]
}

/**
 * Rotate to the next account
 */
export async function rotateAccount(): Promise<void> {
  const auth = await loadAntigravityAuth()

  if (!auth || auth.accounts.length <= 1) {
    return
  }

  // Find next enabled account
  let nextIndex = (auth.currentIndex + 1) % auth.accounts.length
  let attempts = 0

  while (!auth.accounts[nextIndex].enable && attempts < auth.accounts.length) {
    nextIndex = (nextIndex + 1) % auth.accounts.length
    attempts++
  }

  auth.currentIndex = nextIndex
  await saveAntigravityAuth(auth)
  consola.info(`Rotated to account ${nextIndex}`)
}

/**
 * Disable current account
 */
export async function disableCurrentAccount(): Promise<void> {
  const auth = await loadAntigravityAuth()

  if (!auth || auth.accounts.length === 0) {
    return
  }

  auth.accounts[auth.currentIndex].enable = false
  await saveAntigravityAuth(auth)
  consola.warn(`Disabled account ${auth.currentIndex}`)

  // Rotate to next account
  await rotateAccount()
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(
  account: AntigravityAccount,
): Promise<AntigravityAccount | null> {
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: account.refresh_token,
        grant_type: "refresh_token",
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      consola.error("Token refresh failed:", error)
      return null
    }

    const data = (await response.json()) as {
      access_token: string
      expires_in: number
    }

    return {
      ...account,
      access_token: data.access_token,
      expires_in: data.expires_in,
      timestamp: Date.now(),
    }
  } catch (error) {
    consola.error("Token refresh error:", error)
    return null
  }
}

/**
 * Check if token is expired
 */
export function isTokenExpired(account: AntigravityAccount): boolean {
  const expirationTime = account.timestamp + account.expires_in * 1000
  // Refresh 5 minutes before expiration
  return Date.now() > expirationTime - 5 * 60 * 1000
}

/**
 * Get valid access token, refreshing if needed
 */
export async function getValidAccessToken(): Promise<string | null> {
  const auth = await loadAntigravityAuth()

  if (!auth || auth.accounts.length === 0) {
    return null
  }

  let account = auth.accounts[auth.currentIndex]

  if (!account || !account.enable) {
    const enabledAccount = auth.accounts.find((a) => a.enable)
    if (!enabledAccount) {
      return null
    }
    account = enabledAccount
  }

  // Check if token needs refresh
  if (isTokenExpired(account)) {
    consola.info("Access token expired, refreshing...")
    const refreshedAccount = await refreshAccessToken(account)

    if (!refreshedAccount) {
      consola.error("Token refresh failed, disabling account")
      await disableCurrentAccount()
      return getValidAccessToken() // Try next account
    }

    // Update account in storage
    auth.accounts[auth.currentIndex] = refreshedAccount
    await saveAntigravityAuth(auth)

    return refreshedAccount.access_token
  }

  return account.access_token
}

/**
 * Get current project ID
 */
export async function getCurrentProjectId(): Promise<string | null> {
  const auth = await loadAntigravityAuth()

  if (!auth || auth.accounts.length === 0) {
    return null
  }

  let account = auth.accounts[auth.currentIndex]

  if (!account || !account.enable) {
    const enabledAccount = auth.accounts.find((a) => a.enable)
    if (!enabledAccount) {
      return null
    }
    account = enabledAccount
  }

  return account.project_id ?? null
}

/**
 * Generate a random project ID for Pro accounts
 */
export function generateRandomProjectId(): string {
  const chars = "0123456789"
  let projectId = ""
  for (let i = 0; i < 12; i++) {
    projectId += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return projectId
}

/**
 * Get OAuth authorization URL
 */
export function getOAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  })

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  code: string,
): Promise<AntigravityAccount | null> {
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      consola.error("Token exchange failed:", error)
      return null
    }

    const data = (await response.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      timestamp: Date.now(),
      enable: true,
      project_id: generateRandomProjectId(),
    }
  } catch (error) {
    consola.error("Token exchange error:", error)
    return null
  }
}

/**
 * Start a local OAuth callback server and wait for authorization
 * This provides a seamless web-based login experience
 * Uses Node.js http module for compatibility with both Node.js and Bun
 *
 * @param onServerReady - Callback function called when server is ready to accept connections
 */
async function startOAuthCallbackServer(
  onServerReady?: () => void,
): Promise<string> {
  const http = await import("node:http")

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:8046`)

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code")
        const error = url.searchParams.get("error")

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" })
          res.end(
            `<html><body><h1>Authorization Failed</h1><p>Error: ${error}</p><p>You can close this window.</p></body></html>`,
          )
          setTimeout(() => server.close(), 100)
          reject(new Error(`OAuth error: ${error}`))
          return
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" })
          res.end(
            `<html><body><h1>Authorization Successful!</h1><p>You can close this window and return to the terminal.</p></body></html>`,
          )
          setTimeout(() => server.close(), 100)
          resolve(code)
          return
        }

        res.writeHead(400, { "Content-Type": "text/plain" })
        res.end("Missing authorization code")
        return
      }

      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("Not found")
    })

    server.listen(8046, () => {
      consola.info(`OAuth callback server started on http://localhost:8046`)

      // Call the callback to signal server is ready
      if (onServerReady) {
        onServerReady()
      }
    })

    // Timeout after 5 minutes
    setTimeout(
      () => {
        server.close()
        reject(
          new Error("OAuth timeout - no callback received within 5 minutes"),
        )
      },
      5 * 60 * 1000,
    )
  })
}

/**
 * Setup Antigravity with web-based OAuth flow
 * Opens browser for login and automatically captures the callback
 */
export async function setupAntigravityWeb(): Promise<void> {
  const auth = await loadAntigravityAuth()

  if (auth && auth.accounts.length > 0) {
    const enabledCount = auth.accounts.filter((a) => a.enable).length
    consola.info(
      `Found ${auth.accounts.length} Antigravity accounts (${enabledCount} enabled)`,
    )

    const addMore = await consola.prompt("Add another account?", {
      type: "confirm",
      initial: false,
    })

    if (!addMore) {
      return
    }
  }

  consola.info("")
  consola.info("Google Antigravity OAuth Setup (Web Flow)")
  consola.info("=========================================")
  consola.info("")

  const oauthUrl = getOAuthUrl()

  // Function to open browser - will be called after server is ready
  const openBrowser = async () => {
    consola.info("Opening browser for Google login...")
    consola.info(`If browser doesn't open, visit: ${oauthUrl}`)
    consola.info("")

    try {
      const { exec } = await import("node:child_process")
      const platform = process.platform

      if (platform === "win32") {
        exec(`start "" "${oauthUrl}"`)
      } else if (platform === "darwin") {
        exec(`open "${oauthUrl}"`)
      } else {
        exec(`xdg-open "${oauthUrl}"`)
      }
    } catch {
      consola.warn("Could not open browser automatically")
    }

    consola.info("Waiting for authorization...")
  }

  try {
    // Start server first, then open browser when server is ready
    const code = await startOAuthCallbackServer(() => {
      // Use setImmediate to ensure this runs after the server is fully ready
      setImmediate(() => {
        openBrowser().catch(() => {
          // Ignore browser open errors
        })
      })
    })

    consola.info("Authorization code received, exchanging for tokens...")

    const account = await exchangeCodeForTokens(code)

    if (!account) {
      throw new Error("Failed to exchange authorization code")
    }

    await addAntigravityAccount(account)
    consola.success("Antigravity account added successfully!")
  } catch (error) {
    consola.error("OAuth flow failed:", error)
    throw error
  }
}

/**
 * Setup Antigravity interactively (manual URL copy method)
 */
export async function setupAntigravityManual(): Promise<void> {
  const auth = await loadAntigravityAuth()

  if (auth && auth.accounts.length > 0) {
    const enabledCount = auth.accounts.filter((a) => a.enable).length
    consola.info(
      `Found ${auth.accounts.length} Antigravity accounts (${enabledCount} enabled)`,
    )

    const addMore = await consola.prompt("Add another account?", {
      type: "confirm",
      initial: false,
    })

    if (!addMore) {
      return
    }
  }

  consola.info("")
  consola.info("Google Antigravity OAuth Setup (Manual)")
  consola.info("=======================================")
  consola.info("")
  consola.info("You need to authorize with Google to use Antigravity API.")
  consola.info("Please follow these steps:")
  consola.info("")
  consola.info("1. Open this URL in your browser:")
  consola.info(`   ${getOAuthUrl()}`)
  consola.info("")
  consola.info("2. Complete the Google sign-in process")
  consola.info("3. After authorization, you'll be redirected to a callback URL")
  consola.info("4. Copy the full callback URL and paste it below")
  consola.info("")

  const callbackUrl = await consola.prompt("Enter the callback URL:", {
    type: "text",
  })

  if (!callbackUrl || typeof callbackUrl !== "string") {
    throw new Error("Callback URL is required")
  }

  // Extract code from callback URL
  const url = new URL(callbackUrl)
  const code = url.searchParams.get("code")

  if (!code) {
    throw new Error("Authorization code not found in URL")
  }

  consola.info("Exchanging authorization code for tokens...")

  const account = await exchangeCodeForTokens(code)

  if (!account) {
    throw new Error("Failed to exchange authorization code")
  }

  await addAntigravityAccount(account)
  consola.success("Antigravity account added successfully!")
}

/**
 * Setup Antigravity interactively
 * Offers choice between web-based and manual OAuth flow
 */
export async function setupAntigravity(): Promise<void> {
  const method = await consola.prompt("Choose OAuth login method:", {
    type: "select",
    options: [
      { value: "web", label: "Web (auto-open browser, recommended)" },
      { value: "manual", label: "Manual (copy/paste callback URL)" },
    ],
  })

  await (method === "web" ? setupAntigravityWeb() : setupAntigravityManual())
}
