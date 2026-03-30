#!/usr/bin/env node

import { defineCommand, runMain } from "citty"

import { addAccount, listAccounts, removeAccount } from "./account"
import { auth } from "./auth"
import { checkUsage } from "./check-usage"
import { debug } from "./debug"
import { logout } from "./logout"
import { proxy } from "./proxy-config"
import { start } from "./start"

const main = defineCommand({
  meta: {
    name: "copilot-api-plus",
    description:
      "A wrapper around GitHub Copilot API to make it OpenAI/Anthropic compatible. Fork with bug fixes and improvements.",
  },
  subCommands: {
    auth,
    start,
    "check-usage": checkUsage,
    "add-account": addAccount,
    "list-accounts": listAccounts,
    "remove-account": removeAccount,
    debug,
    logout,
    proxy,
  },
})

await runMain(main)
