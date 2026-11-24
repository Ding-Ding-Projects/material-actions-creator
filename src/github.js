// Minimal GitHub REST client. `fetchImpl` is injectable so tests run offline.

export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GitHubClient {
  constructor({ token, apiUrl = 'https://api.github.com', fetchImpl = globalThis.fetch, sleepImpl = sleep } = {}) {
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
  }

  headers(extra = {}) {
    return {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'material-actions-creator',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  async request(method, path, body, { allow404 = false, raw = false } = {}) {
    const res = await this.fetch(`${this.apiUrl}${path}`, {
      method,
      headers: this.headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      redirect: raw ? 'follow' : undefined,
    });
    if (raw && res.ok) return res;
    if (allow404 && res.status === 404) return null;
    if (res.status === 204) return { _headers: res.headers };
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    if (!res.ok) {
      throw new GitHubError(`GitHub ${method} ${path} failed (${res.status}): ${data?.message || 'unknown error'}`, res.status, data);
    }
    if (data && typeof data === 'object' && res.headers) Object.defineProperty(data, '_headers', { value: res.headers });
    return data;
  }

  async viewer() {
    const data = await this.request('GET', '/user');
    const scopes = (data._headers?.get?.('x-oauth-scopes') || '').split(',').map((s) => s.trim()).filter(Boolean);
    return { login: data.login, scopes, avatarUrl: data.avatar_url };
  }

  async ownerType(owner) {
    const data = await this.request('GET', `/users/${encodeURIComponent(owner)}`);
    return data.type; // "User" | "Organization"
  }

  async createRepo(owner, name, { isOrg, description }) {
    const payload = { name, description, private: true, auto_init: false, has_issues: false, has_wiki: false, has_projects: false };
    return isOrg
      ? this.request('POST', `/orgs/${encodeURIComponent(owner)}/repos`, payload)
      : this.request('POST', '/user/repos', payload);
  }

  async putFile(owner, repo, path, content, message) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return this.request('PUT', `/repos/${owner}/${repo}/contents/${encoded}`, {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
    });
  }

  async setTopics(owner, repo, names) {
    return this.request('PUT', `/repos/${owner}/${repo}/topics`, { names });
  }

  async dispatchWorkflow(owner, repo, workflow, ref) {
    // GitHub can 404 for a few seconds right after the workflow file lands.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request('POST', `/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, { ref });
      } catch (err) {
        if (attempt >= 9 || ![404, 422].includes(err.status)) throw err;
        await this.sleep(3000);
      }
    }
  }

  async latestRun(owner, repo, workflow) {
    const data = await this.request('GET', `/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?per_page=1&event=workflow_dispatch`);
    return data.workflow_runs?.[0] || null;
  }

  async getRun(owner, repo, runId) {
    return this.request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}`);
  }

  async runJobs(owner, repo, runId) {
    const data = await this.request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
    return data.jobs || [];
  }

  async runArtifacts(owner, repo, runId) {
    const data = await this.request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`);
    return data.artifacts || [];
  }

  async downloadArtifact(owner, repo, artifactId) {
    return this.request('GET', `/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, null, { raw: true });
  }

  async deleteRepo(owner, repo) {
    return this.request('DELETE', `/repos/${owner}/${repo}`, null, { allow404: true });
  }

  async listRepos(owner, isOrg) {
    const path = isOrg ? `/orgs/${encodeURIComponent(owner)}/repos?per_page=100&type=private` : '/user/repos?per_page=100&affiliation=owner&visibility=private';
    return this.request('GET', path);
  }
}
