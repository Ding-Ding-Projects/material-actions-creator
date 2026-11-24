// Short-lived credentials for encrypted public runs.
// With a GitHub App configured, every encrypted run mints its own installation
// token (expires after one hour, revoked as soon as the run is cleaned up).
// The App can always mint a fresh one later, so cleanup still works after the
// app was offline for longer than a token lives.
import { createSign } from 'node:crypto';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function appJwt(appId, privateKeyPem, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`;
}

export class GitHubApp {
  constructor({ appId, privateKey, installationId, apiUrl = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
    this.appId = appId;
    this.privateKey = String(privateKey || '').replace(/\\n/g, '\n');
    this.installationId = installationId;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
  }

  static fromEnv(env, fetchImpl) {
    if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_INSTALLATION_ID) return null;
    return new GitHubApp({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
      apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
      fetchImpl,
    });
  }

  // Returns { token, expiresAt }.
  async mintToken() {
    const res = await this.fetch(`${this.apiUrl}/app/installations/${this.installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt(this.appId, this.privateKey)}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'material-actions-creator',
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Could not mint a temporary key (${res.status}): ${data.message || 'unknown error'}`);
    return { token: data.token, expiresAt: Date.parse(data.expires_at) };
  }
}
