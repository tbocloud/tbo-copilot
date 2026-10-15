import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../../.github/workflows/tbo-plugins.yml", import.meta.url),
  "utf8",
);

test("TBO plugin checks run when the plugins, their build script or the plugin CLI change", () => {
  for (const event of ["pull_request", "push"]) {
    assert.match(
      workflow,
      new RegExp(
        `${event}:\\n\\s+branches: \\[tbo\\]\\n\\s+paths:\\n\\s+- 'tbo/plugins/\\*\\*'\\n\\s+- 'scripts/tbo/\\*\\*'\\n\\s+- 'packages/plugin-devkit/\\*\\*'`,
      ),
    );
  }
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  // Pull-request code runs here, so the checkout keeps no token in .git/config.
  assert.match(workflow, /- uses: actions\/checkout@v7\n\s+with:\n(?:\s+#.*\n)*\s+persist-credentials: false/);
});

test("the plugins' unit tests run, then every plugin is checked and packed", () => {
  assert.match(workflow, /run: node --test "tbo\/plugins\/tests\/\*\*\/\*\.test\.js"/);
  assert.match(workflow, /for manifest in tbo\/plugins\/\*\/manifest\.json; do/);
  assert.match(workflow, /node "\$cli" check "\$dir"/);
  assert.match(workflow, /node "\$cli" pack "\$dir" --out tbo\/plugins\/dist/);
  // No plugin folder at all is an error, not a silent pass.
  assert.match(workflow, /if \[ "\$found" -eq 0 \]; then\n\s+echo "::error::/);
  assert.doesNotMatch(workflow, /secrets\./);
});
