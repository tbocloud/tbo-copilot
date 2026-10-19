import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HubClient, HubError, frappeError } from "./hub.js";
import { StubHub } from "./test-support/stub-hub.js";

const context = { run: "CPR-1", kind: "investigate", ticket: { name: "0209" } };

describe("HubClient against a stub hub", () => {
  const stub = new StubHub();
  let hub: HubClient;

  beforeAll(async () => {
    await stub.start();
    stub.jobs.push({ run: "CPR-1", lease_token: "tok", lease_expires: "", context }, { run: "CPR-2", lease_token: "tok2", lease_expires: "", context: { ...context, run: "CPR-2" } });
    hub = new HubClient(stub.url, { apiKey: "key", apiSecret: "secret" });
  });
  afterAll(() => stub.stop());

  it("claims the named run with the worker's key", async () => {
    const job = await hub.claimJob("w1", "CPR-2");
    expect(job?.run).toBe("CPR-2");
    const call = stub.callsTo("claim_job")[0]!;
    expect(call.headers.authorization).toBe("token key:secret");
    expect(call.body).toMatchObject({ worker_id: "w1", run: "CPR-2" });
  });

  it("calls the run's tools with the run token and keeps a tool's refusal as data", async () => {
    await hub.claimJob("w1", "CPR-1");
    const ok = await hub.callTool("CPR-1:tok", "get_run_context", {});
    expect(JSON.parse(ok.text).ticket.name).toBe("0209");
    const call = stub.callsTo("get_run_context")[0]!;
    expect(call.headers["x-copilot-run-token"]).toBe("CPR-1:tok");
    expect(call.headers.authorization).toBeUndefined();
    expect(await hub.callTool("CPR-1:tok", "customer_erp_read", { tool: "get_doc" })).toEqual({ text: "The customer site refused get_doc", isError: true });
  });

  it("never takes a reply without a JSON-RPC result for a result", async () => {
    for (const raw of ["<html>proxy error</html>", JSON.stringify({ jsonrpc: "2.0", id: 1 })]) {
      stub.rawMcpReply = raw;
      await expect(hub.callTool("CPR-1:tok", "submit_investigation", {})).rejects.toThrow("the hub gave no result for submit_investigation");
    }
    stub.rawMcpReply = undefined;
  });

  it("reports a lost lease as such", async () => {
    await expect(hub.heartbeat("CPR-1", "wrong", "investigate")).rejects.toMatchObject({ leaseGone: true, message: "This lease is not valid" });
    const error = await hub.callTool("CPR-1:wrong", "get_run_context", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubError);
    expect((error as HubError).leaseGone).toBe(true);
  });

  it("needs an agent's key for the evaluation calls", async () => {
    await expect(hub.startRun("0001", "billing_app", "abc1234")).rejects.toThrow("TBO_HUB_AGENT_API_KEY");
  });
});

describe("frappeError", () => {
  it("prefers the server message, then the exception line", () => {
    expect(frappeError({ exc_type: "ValidationError", _server_messages: JSON.stringify([JSON.stringify({ message: "<b>Bad</b> value" })]) }, "x")).toEqual({
      message: "Bad value",
      excType: "ValidationError",
    });
    expect(frappeError({ exception: "Traceback\nfrappe.exceptions.PermissionError: nope" }, "x").message).toBe("frappe.exceptions.PermissionError: nope");
    expect(frappeError("not json", "fallback").message).toBe("fallback");
  });

  it("reads a ticket's file only up to its limit, whatever the length header says", async () => {
    const body = (size: number, length?: number) =>
      (async () => new Response(new Uint8Array(size), { status: 200, headers: length === undefined ? {} : { "content-length": String(length) } })) as unknown as typeof fetch;
    const client = (size: number, length?: number) => new HubClient("https://hub.example.com", { apiKey: "k", apiSecret: "s" }, { fetch: body(size, length) });
    expect((await client(8).ticketFile("r", "t", "/f.png", 10)).length).toBe(8);
    await expect(client(20).ticketFile("r", "t", "/f.png", 10)).rejects.toThrow("larger than");
    await expect(client(5, 20).ticketFile("r", "t", "/f.png", 10)).rejects.toThrow("larger than");
  });
});
