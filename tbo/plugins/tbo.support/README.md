# TBO Support (`tbo.support`)

Signs TBO Copilot in with your **Microsoft** work account through TBO Support, gives it **TBO AI**, and lets the agent **read** TBO Support: tickets and their conversation, internal notes, AI triage, fix brief, session replay, possible duplicates, the suggested reply, the estimate, and the knowledge base. It cannot change anything.

Design: [`docs/tbo/tbo-support-plugin.md`](../../../docs/tbo/tbo-support-plugin.md).

## Use it

1. **Sign in.** TBO Copilot opens the TBO Support panel when nobody is signed in (or press `Cmd/Ctrl+K` and run
   **TBO Support: Sign in**). Press **Sign in with Microsoft**. Your browser opens TBO Support: log in with your
   Microsoft work account, check that the page shows the same code as the panel, and press **Allow**.
2. **Use TBO AI.** Pick **TBO AI** as the model. Its key comes from the sign-in; you never see or type it.
3. **Ask the agent**, in Agent or Plan mode. For example:
   - "Summarise TBO Support ticket 1234 and show its fix brief."
   - "List my open TBO Support tickets."
   - "Find tickets like 1234 and check the knowledge base for 'print format'."

Other commands: **TBO Support: Check connection**, **TBO Support: Sign out**.

You see only what your TBO Support account may see. Every call runs as you. The sign-in lasts 30 days; TBO Support
can end it sooner (for example when you leave a team), and the plugin then clears TBO AI too.

**A local test site** (`http://tbo.localhost:8002` and the like; set it in the plugin's settings) can use an API key
instead: the panel shows the form only there. A System Manager generates it: your user → **API Access → Generate
Keys**.

## Develop

```bash
# from the repository root; build the pi-plugin CLI once: pnpm --filter '@pi-desktop/plugin-devkit...' build
node --test "tbo/plugins/tests/**/*.test.js"                              # unit tests
pnpm pi-plugin check tbo/plugins/tbo.support                              # validate
pnpm pi-plugin pack tbo/plugins/tbo.support --out tbo/plugins/dist        # build tbo.support-<version>.piplug
```

To try changes, load this folder in TBO Copilot: **Plugins → Load development plugin**. Edits reload automatically. Logs: **Settings → Info → Logs**, search for `tbo.support`.

The tool code (`lib/actions.js`, `lib/helpdesk.js`, `lib/shape.js`) does not depend on the app, so a later MCP server can reuse it on the TBO Copilot backend.
