import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One reply: a tool call, a closing text, or a provider failure (an HTTP status and its message). */
export type ModelStep = { text?: string; tool?: { name: string; arguments: Record<string, unknown> }; fail?: { status: number; message: string } };
export type ModelRequest = { messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>; tools?: Array<{ function?: { name?: string } }> };

/**
 * An OpenAI-compatible chat-completions server that streams a fixed script:
 * reply N to request N. Each step is one tool call or a closing text. Every
 * request is recorded so a test can read the tool results the engine sent back.
 */
export class FakeModel {
  readonly requests: ModelRequest[] = [];
  private server: Server | undefined;
  url = "";

  constructor(private readonly script: ModelStep[]) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/v1`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** The tool results (role `tool`) the engine sent with the last request, in order. */
  toolResults(): string[] {
    const last = this.requests.at(-1);
    return (last?.messages ?? [])
      .filter((message) => message.role === "tool")
      .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as ModelRequest;
    this.requests.push(body);
    const step = this.script[this.requests.length - 1] ?? { text: "Done." };
    if (step.fail) {
      res.writeHead(step.fail.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: step.fail.message, type: "invalid_request_error" } }));
      return;
    }
    const id = `chatcmpl-${this.requests.length}`;
    const base = { id, object: "chat.completion.chunk", created: 1_760_000_000, model: "fake-model" };
    const frames: unknown[] = [];
    if (step.tool) {
      frames.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: null,
              tool_calls: [{ index: 0, id: `call_${this.requests.length}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.arguments) } }],
            },
            finish_reason: null,
          },
        ],
      });
      frames.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      frames.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: step.text ?? "Done." }, finish_reason: null }] });
      frames.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    frames.push({ ...base, choices: [], usage: { prompt_tokens: 1_000, completion_tokens: 50, total_tokens: 1_050 } });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.end("data: [DONE]\n\n");
  }
}
