import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { getConfigPath, loadConfig } from "~/lib/config"
import { modelRouter, type ModelMappingConfig } from "~/lib/model-router"
import { PATHS } from "~/lib/paths"
import { modelAdminRoutes } from "~/routes/admin/models"

const originalDataDir = PATHS.DATA_DIR
const spies: Array<{ mockRestore: () => void }> = []
let testDir: string
let originalRouting: ModelMappingConfig
const initialRouting = {
  mapping: { original: "original-model" },
  concurrency: { default: 2 },
}

beforeEach(async () => {
  testDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "copilot-model-config-test-"),
  )
  PATHS.DATA_DIR = testDir
  originalRouting = modelRouter.getConfig()
  modelRouter.updateMapping(initialRouting.mapping)
  modelRouter.updateConcurrency(initialRouting.concurrency)
  await fs.writeFile(
    getConfigPath(),
    JSON.stringify({ modelMapping: initialRouting }),
    "utf8",
  )
})

afterEach(async () => {
  for (const spy of spies) spy.mockRestore()
  spies.length = 0
  modelRouter.updateMapping(originalRouting.mapping)
  modelRouter.updateConcurrency(originalRouting.concurrency)
  PATHS.DATA_DIR = originalDataDir
  for (const entry of await fs.readdir(testDir)) {
    await fs.unlink(path.join(testDir, entry))
  }
  await fs.rmdir(testDir)
})

function updateConfig(
  endpoint: string,
  body: unknown,
): Response | Promise<Response> {
  return modelAdminRoutes.request(`/${endpoint}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe.each(["mapping", "concurrency"])(
  "model %s configuration",
  (endpoint) => {
    test("changes runtime only after the atomic replacement completes", async () => {
      const rename = fs.rename.bind(fs)
      const beforeRename = Promise.withResolvers<undefined>()
      const releaseRename = Promise.withResolvers<undefined>()
      spies.push(
        spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
          beforeRename.resolve(undefined)
          await releaseRename.promise
          await rename(oldPath, newPath)
        }),
      )
      const value =
        endpoint === "mapping" ? { new: "new-model" } : { default: 3 }
      const pending = Promise.resolve(
        updateConfig(endpoint, { [endpoint]: value }),
      )

      try {
        await beforeRename.promise
        expect(modelRouter.getConfig()).toEqual(initialRouting)
        expect(await loadConfig()).toEqual({ modelMapping: initialRouting })
      } finally {
        releaseRename.resolve(undefined)
        await pending
      }

      expect((await pending).status).toBe(200)
      expect(modelRouter.getConfig()).toEqual({
        ...initialRouting,
        [endpoint]: value,
      })
      expect(await loadConfig()).toEqual({
        modelMapping: { ...initialRouting, [endpoint]: value },
      })
    })

    test("keeps runtime and disk unchanged when saving fails", async () => {
      spies.push(
        spyOn(fs, "writeFile").mockRejectedValue(
          new Error("test write failure"),
        ),
      )
      const value =
        endpoint === "mapping" ? { new: "new-model" } : { default: 3 }

      const response = await updateConfig(endpoint, { [endpoint]: value })

      expect(response.status).toBe(500)
      expect(modelRouter.getConfig()).toEqual(initialRouting)
      expect(await loadConfig()).toEqual({ modelMapping: initialRouting })
    })

    test.each([null, [], { invalid: true }].map((body) => [body]))(
      "rejects an invalid body before saving (%j)",
      async (body) => {
        const response = await updateConfig(endpoint, body)

        expect(response.status).toBe(400)
        expect(modelRouter.getConfig()).toEqual(initialRouting)
        expect(await loadConfig()).toEqual({ modelMapping: initialRouting })
      },
    )

    test.each([null, [], "invalid", { invalid: null }].map((value) => [value]))(
      "rejects an invalid configuration field before saving (%j)",
      async (value) => {
        const response = await updateConfig(endpoint, { [endpoint]: value })

        expect(response.status).toBe(400)
        expect(modelRouter.getConfig()).toEqual(initialRouting)
        expect(await loadConfig()).toEqual({ modelMapping: initialRouting })
      },
    )

    test("returns 400 for malformed JSON", async () => {
      const response = await modelAdminRoutes.request(`/${endpoint}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{broken",
      })

      expect(response.status).toBe(400)
      expect(modelRouter.getConfig()).toEqual(initialRouting)
    })
  },
)

test("concurrent mapping and concurrency updates retain both saved values", async () => {
  const responses = await Promise.all([
    updateConfig("mapping", { mapping: { new: "new-model" } }),
    updateConfig("concurrency", { concurrency: { default: 3 } }),
  ])

  expect(responses.map((response) => response.status)).toEqual([200, 200])
  const expected = {
    mapping: { new: "new-model" },
    concurrency: { default: 3 },
  }
  expect(modelRouter.getConfig()).toEqual(expected)
  expect(await loadConfig()).toEqual({ modelMapping: expected })
})
