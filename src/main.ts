#!/usr/bin/env node

import { defineCommand, runMain } from "citty"

import { auth } from "./auth"
import { checkUsage } from "./check-usage"
import { debug } from "./debug"
import { logout } from "./logout"
import { start } from "./start"

const main = defineCommand({
  meta: {
    name: "copilot-api-plus",
    description:
      "A wrapper around GitHub Copilot API to make it OpenAI/Anthropic compatible. Fork with bug fixes and improvements.",
  },
  subCommands: { auth, start, "check-usage": checkUsage, debug, logout },
})

await runMain(main)
