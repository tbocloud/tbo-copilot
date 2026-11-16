"use strict";

// TBO Frappe Dev plugin (TBO Copilot Phase 20, TASK-2026-00021): Frappe and ERPNext work from a
// TBO Support task, the way TBO does it. Two tools (lib/dev.js) and four skills: TBO's Frappe
// conventions, a new app and its parts, /start-task and /open-pr. The task itself is read with
// the tbo_support tool of the TBO Support plugin. See docs/tbo/frappe-dev.md.

const { createDev, DEV_TOOL, PR_TOOL } = require("./lib/dev");

let dev = null;

async function onLoad() {
  dev = createDev({
    getSettings: () => pi.plugin.getSettings(),
    getDataPath: () => pi.plugin.getDataPath(),
    getWorkspace: () => pi.workspace.get(),
  });
  await pi.agent.registerTool({
    ...DEV_TOOL,
    execute: async (args, ctx) => {
      if (ctx && ctx.log) ctx.log(`tbo_dev ${args && args.action}`);
      return dev.runDev(args);
    },
  });
  await pi.agent.registerTool({
    ...PR_TOOL,
    execute: async (args, ctx) => {
      if (ctx && ctx.log) ctx.log("tbo_dev_pr open_pr");
      return dev.runPr(args);
    },
  });
}

async function onUnload() {
  await pi.agent.unregisterTool(DEV_TOOL.name).catch(() => {});
  await pi.agent.unregisterTool(PR_TOOL.name).catch(() => {});
  dev = null;
}

module.exports = { onLoad, onUnload };
