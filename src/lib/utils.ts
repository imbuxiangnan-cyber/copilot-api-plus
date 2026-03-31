import consola from "consola"

import type { Model } from "~/services/copilot/get-models"

import { getModels } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"

import { state } from "./state"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

export async function cacheModels(): Promise<void> {
  const models = await getModels()
  state.models = models
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}

/**
 * Find a model in state.models using multi-strategy exact matching.
 *
 * Strategies (in order):
 * 1. Exact match on model ID
 * 2. Strip date suffix (claude-opus-4-6-20251101 → claude-opus-4-6)
 * 3. Dash to dot version (claude-opus-4-5 → claude-opus-4.5)
 * 4. Dot to dash version (claude-opus-4.5 → claude-opus-4-5)
 *
 * No fuzzy/family matching — all strategies produce deterministic exact IDs.
 */
export function findModel(modelName: string): Model | undefined {
  const models = state.models?.data
  if (!models || models.length === 0) {
    return undefined
  }

  // 1. Exact match
  const exact = models.find((m) => m.id === modelName)
  if (exact) return exact

  // 2. Strip date suffix
  const base = modelName.replace(/-\d{8}$/, "")
  if (base !== modelName) {
    const baseMatch = models.find((m) => m.id === base)
    if (baseMatch) return baseMatch
  }

  // 3. Dash to dot version (4-5 → 4.5)
  const withDot = base.replace(/-(\d+)-(\d+)$/, "-$1.$2")
  if (withDot !== base) {
    const dotMatch = models.find((m) => m.id === withDot)
    if (dotMatch) return dotMatch
  }

  // 4. Dot to dash version (4.5 → 4-5)
  const withDash = modelName.replace(/(\d+)\.(\d+)/, "$1-$2")
  if (withDash !== modelName) {
    const dashMatch = models.find((m) => m.id === withDash)
    if (dashMatch) return dashMatch
  }

  return undefined
}
