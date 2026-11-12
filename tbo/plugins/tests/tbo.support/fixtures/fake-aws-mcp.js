"use strict";

// A stand-in for awslabs.aws-api-mcp-server in the tests: it speaks MCP over
// stdio and answers call_aws the way the real one does, deciding "read" by the
// operation's verb. It never calls AWS.

const readline = require("node:readline");

const READ_ONLY = process.env.READ_OPERATIONS_ONLY === "true";
const READ_VERBS = /^(describe|list|get|head|ls)/;
const rl = readline.createInterface({ input: process.stdin });
const waiting = new Map(); // id of our question -> what to do with the answer

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

// the real server's shape: CallAWSResponse { cli_command, response: { response: { json | error } } }
function ok(command, json) {
  return { cli_command: command, response: { response: { error: null, status_code: 200, json }, metadata: { service: "fake" } } };
}

function answer(id, items, structured) {
  if (structured) send({ jsonrpc: "2.0", id, result: { content: [], structuredContent: { result: items } } });
  else send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(items) }] } });
}

function callAws(id, command) {
  const [, service, operation] = command.split(/\s+/);
  const read = READ_VERBS.test(operation || "") || service === "s3" && operation === "ls";
  if (READ_ONLY && !read) {
    return answer(id, [{ cli_command: command, error: "Execution of this operation is denied by security policy." }]);
  }
  if (command.includes("expired")) {
    return answer(id, [{ cli_command: command, error: "Error while executing the command: Token has expired and refresh failed" }]);
  }
  if (command.includes("refuse-me")) {
    return answer(id, [{ cli_command: command, response: { response: { error: "User is not authorized to perform this operation", error_code: "AccessDenied", status_code: 403 } } }]);
  }
  if (command.includes("leak")) {
    const leaked = { AccessKeyId: "AKIAABCDEFGHIJKLMNOP", SecretAccessKey: "very-secret", note: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----" };
    return answer(id, [ok(command, JSON.stringify(leaked))]);
  }
  if (command.includes("ping-first")) {
    // the server asks the client something first; the answer comes after the client's reply
    waiting.set("p1", () => answer(id, [ok(command, '{"pinged":true}')]));
    return send({ jsonrpc: "2.0", id: "p1", method: "ping" });
  }
  if (command.includes("ask-consent")) {
    waiting.set("e1", (reply) =>
      answer(id, [ok(command, JSON.stringify({ consent: reply.error ? reply.error.code : "given" }))]),
    );
    return send({ jsonrpc: "2.0", id: "e1", method: "elicitation/create", params: { message: "Allow?" } });
  }
  const out = {
    ok: true,
    command,
    readOnly: READ_ONLY,
    profile: process.env.AWS_API_MCP_PROFILE_NAME || null,
    region: process.env.AWS_REGION || null,
    keyForwarded: Boolean(process.env.AWS_ACCESS_KEY_ID),
  };
  return answer(id, [ok(command, JSON.stringify(out))], command.includes("structured"));
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id != null && !msg.method && waiting.has(msg.id)) {
    const next = waiting.get(msg.id);
    waiting.delete(msg.id);
    return next(msg);
  }
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-aws", version: "0" } } });
  }
  if (msg.method === "tools/call" && msg.params.name === "call_aws") return callAws(msg.id, msg.params.arguments.cli_command);
  if (msg.id != null) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown" } });
});
