/** The little of GitHub's REST API a fix job needs, with the hub's one-repository push key. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type PullRequest = { number: number; html_url: string; head: { sha: string } };

export class GitHubRest {
  constructor(
    private readonly api: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.api}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      // keep the text for the error
    }
    if (response.status >= 400) {
      const message = (data as { message?: string } | undefined)?.message ?? text.slice(0, 300);
      throw new GitHubError(`GitHub ${response.status}: ${message}`, response.status);
    }
    return data as T;
  }

  createPull(repo: string, token: string, pull: { title: string; head: string; base: string; body: string }): Promise<PullRequest> {
    return this.call("POST", `/repos/${repo}/pulls`, token, { ...pull, draft: false, maintainer_can_modify: false });
  }

  addLabels(repo: string, token: string, number: number, labels: string[]): Promise<unknown> {
    return this.call("POST", `/repos/${repo}/issues/${number}/labels`, token, { labels });
  }
}
