# TBO Support (`tbo.support`)

Lets the TBO Copilot agent **read** TBO Support: tickets and their conversation, internal notes, AI triage, fix brief, session replay, possible duplicates, the suggested reply, the estimate, and the knowledge base. It cannot change anything.

Design: [`docs/tbo-support-plugin.md`](../docs/tbo-support-plugin.md).

## Use it

1. **Get your API key.** Ask a TBO Support admin (System Manager) to open your user in TBO Support and click **API Access → Generate Keys**. Frappe lets only a System Manager do this. The secret is shown once, so they should give it to you directly, not in a shared chat.
2. **Sign in.** In TBO Copilot, open the command menu (`Cmd/Ctrl+K`) and run **TBO Support: Sign in**. Paste the key and secret. The plugin checks them first, then keeps them in your Keychain (macOS) or encrypted for your Windows user.
3. **Ask the agent**, in Agent or Plan mode. For example:
   - "Summarise TBO Support ticket 1234 and show its fix brief."
   - "List my open TBO Support tickets."
   - "Find tickets like 1234 and check the knowledge base for 'print format'."

Other commands: **TBO Support: Check connection**, **TBO Support: Sign out**.

You see only what your TBO Support account may see. Every call runs as you.

## Develop

```bash
node --test "tests/**/*.test.js"                                              # unit tests, from the repo root
node ../tbo-copilot/packages/plugin-devkit/dist/cli.js check tbo.support      # validate
node ../tbo-copilot/packages/plugin-devkit/dist/cli.js pack tbo.support       # build dist/tbo.support-<version>.piplug
```

To try changes, load this folder in TBO Copilot: **Plugins → Load development plugin**. Edits reload automatically. Logs: **Settings → Info → Logs**, search for `tbo.support`.

The tool code (`lib/actions.js`, `lib/helpdesk.js`, `lib/shape.js`) does not depend on the app, so a later MCP server can reuse it on the TBO Copilot backend.
