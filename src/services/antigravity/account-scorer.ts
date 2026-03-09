/**
 * Antigravity Account Scorer
 *
 * Weighted account selection for multi-account management.
 * Replaces simple round-robin rotation with score-based selection
 * considering quota health, token freshness, and reliability.
 */

import consola from "consola"

import type { AntigravityAccount } from "./auth"

// ---------------------------------------------------------------------------
// In-memory stats
// ---------------------------------------------------------------------------

interface AccountStats {
  successes: number
  failures: number
  lastUsed: number
}

const statsMap = new Map<number, AccountStats>()

function getOrCreateStats(index: number): AccountStats {
  let stats = statsMap.get(index)
  if (!stats) {
    stats = { successes: 0, failures: 0, lastUsed: 0 }
    statsMap.set(index, stats)
  }
  return stats
}

/**
 * Record a successful request for the given account index.
 */
export function recordAccountSuccess(index: number): void {
  const stats = getOrCreateStats(index)
  stats.successes++
  stats.lastUsed = Date.now()
}

/**
 * Record a failed request for the given account index.
 */
export function recordAccountFailure(index: number): void {
  const stats = getOrCreateStats(index)
  stats.failures++
  stats.lastUsed = Date.now()
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface AccountScore {
  accountIndex: number
  score: number
  breakdown: {
    quotaHealth: number
    freshness: number
    reliability: number
  }
}

const WEIGHT_QUOTA_HEALTH = 0.6
const WEIGHT_FRESHNESS = 0.2
const WEIGHT_RELIABILITY = 0.2

/**
 * Score a single account based on quota health, token freshness, and
 * historical reliability.
 */
export function scoreAccount(
  account: AntigravityAccount,
  index: number,
): AccountScore {
  const stats = statsMap.get(index)

  // --- quotaHealth: proxy via failure rate ---
  const total = stats ? stats.successes + stats.failures : 0
  const quotaHealth =
    total === 0 || !stats ? 1 : 1 - stats.failures / Math.max(total, 1)

  // --- freshness: remaining token lifetime ---
  const remaining = account.timestamp + account.expires_in * 1000 - Date.now()
  const freshness =
    remaining <= 0 ? 0 : Math.min(remaining / (account.expires_in * 1000), 1)

  // --- reliability: success ratio (default 0.5 when unknown) ---
  const reliability =
    stats && total > 0 ? stats.successes / Math.max(total, 1) : 0.5

  const score =
    quotaHealth * WEIGHT_QUOTA_HEALTH
    + freshness * WEIGHT_FRESHNESS
    + reliability * WEIGHT_RELIABILITY

  return {
    accountIndex: index,
    score,
    breakdown: {
      quotaHealth,
      freshness,
      reliability,
    },
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Tracks the last index returned for round-robin fallback. */
let lastSelectedIndex = -1

/**
 * Select the best enabled account by score.
 *
 * Falls back to round-robin when all scores are equal or no stats exist.
 * Returns 0 when no enabled accounts are found.
 */
export function selectBestAccount(accounts: Array<AntigravityAccount>): number {
  if (accounts.length === 0) return 0

  // Collect enabled accounts with their original indices
  const enabled: Array<{ account: AntigravityAccount; index: number }> = []
  for (const [i, account] of accounts.entries()) {
    if (account.enable) {
      enabled.push({ account: account, index: i })
    }
  }

  if (enabled.length === 0) return 0

  // Score every enabled account
  const scored = enabled.map(({ account, index }) =>
    scoreAccount(account, index),
  )

  // Detect whether all scores are effectively equal (no meaningful data)
  const allEqual = scored.every(
    (s) => Math.abs(s.score - scored[0].score) < 1e-9,
  )

  if (allEqual) {
    // Round-robin fallback: pick the next enabled account after lastSelectedIndex
    const sortedIndices = enabled.map((e) => e.index).sort((a, b) => a - b)
    const nextIdx = sortedIndices.find((i) => i > lastSelectedIndex)
    const selected = nextIdx !== undefined ? nextIdx : sortedIndices[0]
    lastSelectedIndex = selected
    consola.debug(
      `[account-scorer] round-robin fallback -> account ${selected}`,
    )
    return selected
  }

  // Pick highest score
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  lastSelectedIndex = best.accountIndex

  consola.debug(
    `[account-scorer] selected account ${best.accountIndex} `
      + `(score=${best.score.toFixed(3)}, `
      + `quota=${best.breakdown.quotaHealth.toFixed(2)}, `
      + `fresh=${best.breakdown.freshness.toFixed(2)}, `
      + `rel=${best.breakdown.reliability.toFixed(2)})`,
  )

  return best.accountIndex
}
