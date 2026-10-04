import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  clearProxyConfig,
  getConfigPath,
  loadConfig,
  saveConfig,
  saveModelMappingConfig,
  saveProxyConfig,
  type AppConfig,
} from "~/lib/config"
import { PATHS } from "~/lib/paths"

const originalDataDir = PATHS.DATA_DIR
const spies: Array<{ mockRestore: () => void }> = []
let testDir: string

const initialConfig: AppConfig = {
  proxy: { enabled: false },
  modelMapping: { mapping: { old: "old-model" }, concurrency: { default: 2 } },
  search_backend: "duckduckgo",
}

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-config-test-"))
  PATHS.DATA_DIR = testDir
})

afterEach(async () => {
  for (const spy of spies) spy.mockRestore()
  spies.length = 0
  PATHS.DATA_DIR = originalDataDir
  for (const entry of await fs.readdir(testDir)) {
    await fs.unlink(path.join(testDir, entry))
  }
  await fs.rmdir(testDir)
})

async function seedConfig(): Promise<void> {
  await fs.writeFile(getConfigPath(), JSON.stringify(initialConfig), "utf8")
}

describe("configuration persistence", () => {
  test("defaults only a missing file to an empty config", async () => {
    expect(await loadConfig()).toEqual({})
  })

  test.each(["{broken", "null", "[]"])(
    "refuses to overwrite invalid stored configuration %s",
    async (content) => {
      await fs.writeFile(getConfigPath(), content, "utf8")

      const result = await saveProxyConfig({ enabled: true }).catch(
        (error: unknown) => error,
      )

      expect(result).toBeInstanceOf(Error)
      expect(await fs.readFile(getConfigPath(), "utf8")).toBe(content)
    },
  )

  test("propagates read permission failures without writing", async () => {
    await seedConfig()
    const error = Object.assign(new Error("test permission denied"), {
      code: "EACCES",
    })
    const writeSpy = spyOn(fs, "writeFile")
    spies.push(spyOn(fs, "readFile").mockRejectedValue(error), writeSpy)

    const result = await clearProxyConfig().catch((caught: unknown) => caught)

    expect(result).toBe(error)
    expect(writeSpy).not.toHaveBeenCalled()
  })

  test("retains the previous config and removes the temporary file when rename fails", async () => {
    await seedConfig()
    const error = new Error("test rename failure")
    spies.push(spyOn(fs, "rename").mockRejectedValue(error))

    const result = await saveConfig({ proxy: { enabled: true } }).catch(
      (caught: unknown) => caught,
    )

    expect(result).toBe(error)
    expect(await loadConfig()).toEqual(initialConfig)
    expect(await fs.readdir(testDir)).toEqual(["config.json"])
  })

  test("recovers the transaction queue after a failed write", async () => {
    await seedConfig()
    const error = new Error("test write failure")
    const writeSpy = spyOn(fs, "writeFile").mockRejectedValueOnce(error)
    spies.push(writeSpy)

    const result = await saveProxyConfig({ enabled: true }).catch(
      (caught: unknown) => caught,
    )
    expect(result).toBe(error)
    expect(await loadConfig()).toEqual(initialConfig)

    await saveModelMappingConfig({ mapping: { new: "new-model" } })

    expect(await loadConfig()).toEqual({
      ...initialConfig,
      modelMapping: {
        mapping: { new: "new-model" },
        concurrency: { default: 2 },
      },
    })
    expect(await fs.readdir(testDir)).toEqual(["config.json"])
  })

  test("preserves concurrent proxy, mapping, and concurrency updates", async () => {
    await seedConfig()

    await Promise.all([
      saveProxyConfig({
        enabled: true,
        httpProxy: "http://proxy.invalid:8080",
      }),
      saveModelMappingConfig({ mapping: { new: "new-model" } }),
      saveModelMappingConfig({ concurrency: { default: 3 } }),
    ])

    expect(await loadConfig()).toEqual({
      proxy: { enabled: true, httpProxy: "http://proxy.invalid:8080" },
      modelMapping: {
        mapping: { new: "new-model" },
        concurrency: { default: 3 },
      },
      search_backend: "duckduckgo",
    })
  })

  test("serializes proxy removal with model updates", async () => {
    await seedConfig()

    await Promise.all([
      clearProxyConfig(),
      saveModelMappingConfig({ concurrency: { default: 4 } }),
    ])

    expect(await loadConfig()).toEqual({
      modelMapping: {
        mapping: { old: "old-model" },
        concurrency: { default: 4 },
      },
      search_backend: "duckduckgo",
    })
  })

  test("orders full saves with subsequent partial updates", async () => {
    await Promise.all([
      saveConfig(initialConfig),
      saveProxyConfig({ enabled: true }),
      saveModelMappingConfig({ mapping: { latest: "latest-model" } }),
    ])

    expect(await loadConfig()).toEqual({
      ...initialConfig,
      proxy: { enabled: true },
      modelMapping: {
        mapping: { latest: "latest-model" },
        concurrency: { default: 2 },
      },
    })
  })
})
