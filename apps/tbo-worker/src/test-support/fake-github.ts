import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type GitHubCall = { method: string; path: string; auth: string; body: Record<string, unknown> };

/** GitHub's REST API for a fix's pull request: the head commit is read from `remote`, a local repository. */
export class FakeGitHub {
  readonly calls: GitHubCall[] = [];
  private server: Server | undefined;
  url = "";

  constructor(private readonly remote: () => string) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
    const path = req.url ?? "";
    this.calls.push({ method: req.method ?? "", path, auth: String(req.headers.authorization ?? ""), body });
    if (/\/pulls$/.test(path)) {
      const sha = execFileSync("git", ["rev-parse", `refs/heads/${String(body.head)}`], { cwd: this.remote(), encoding: "utf8" }).trim();
      return this.send(res, 201, { number: 7, html_url: `https://github.com/demo/pull/7`, head: { sha } });
    }
    if (/\/issues\/\d+\/labels$/.test(path)) return this.send(res, 200, []);
    this.send(res, 404, { message: "Not Found" });
  }
}
