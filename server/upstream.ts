import type { OAuthState, ServerRecord, ServerStore } from "./store";
import * as oauth from "./oauth";

type Fetch = typeof fetch;

/** Renew this long before expiry, so a token never dies mid-request. */
const SKEW_MS = 60_000;
/** After a transient refresh failure, do not ask the issuer again for this long. */
const BACKOFF_MS = 30_000;

export class AuthRequired extends Error {}

/**
 * Produces the upstream credentials for a server. API keys are read straight from the registry.
 * OAuth access tokens are refreshed on demand, one refresh at a time per server, and a rotated
 * refresh token is stored before the new access token is used.
 */
export class Credentials {
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly backoff = new Map<string, { until: number; message: string }>();

  constructor(
    private readonly store: ServerStore,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  /** Headers to add to an upstream request. Throws AuthRequired when the user must act. */
  async headers(record: ServerRecord, forceRefresh = false): Promise<Record<string, string>> {
    const auth = record.auth;
    if (auth.type === "none") return {};
    if (auth.type === "api-key") {
      if (!auth.key) throw new AuthRequired("No API key is set");
      return { [auth.header]: `${auth.prefix}${auth.key}` };
    }
    if (!auth.oauth?.refreshToken && !auth.oauth?.accessToken) throw new AuthRequired("Needs sign-in");
    return { authorization: `Bearer ${await this.accessToken(record.name, forceRefresh)}` };
  }

  private accessToken(name: string, force: boolean): Promise<string> {
    const current = this.oauthState(name);
    if (!force && current?.accessToken && current.expiresAt && current.expiresAt - SKEW_MS > Date.now()) return Promise.resolve(current.accessToken);
    // An access token without expiry and without refresh token is used as is.
    if (!force && current?.accessToken && !current.expiresAt && !current.refreshToken) return Promise.resolve(current.accessToken);
    const pending = this.inFlight.get(name);
    if (pending) return pending;
    const run = this.renew(name).finally(() => this.inFlight.delete(name));
    this.inFlight.set(name, run);
    return run;
  }

  private oauthState(name: string): OAuthState | null {
    const auth = this.store.get(name)?.auth;
    return auth?.type === "oauth" ? auth.oauth : null;
  }

  private async renew(name: string): Promise<string> {
    const state = this.oauthState(name);
    if (!state?.refreshToken) throw new AuthRequired("Needs sign-in");
    const wait = this.backoff.get(name);
    if (wait && wait.until > Date.now()) throw new Error(wait.message);
    try {
      const def = this.store.get(name)?.oauthClient;
      const tokens = await oauth.refresh(state, this.fetchImpl, def ? oauth.resolveClient(def) : undefined);
      this.save(name, (s) => ({
        ...s,
        accessToken: tokens.accessToken,
        // Providers that rotate refresh tokens return a new one; otherwise keep the old.
        refreshToken: tokens.refreshToken ?? s.refreshToken,
        expiresAt: tokens.expiresAt,
      }));
      this.backoff.delete(name);
      this.setError(name, null);
      return tokens.accessToken;
    } catch (err) {
      if (err instanceof oauth.OAuthError && err.permanent) {
        // The grant is gone: forget it so the screen shows "needs sign-in" and nothing keeps retrying.
        this.save(name, (s) => ({ ...s, refreshToken: undefined, accessToken: undefined, expiresAt: undefined }));
        this.setError(name, "The sign-in expired or was revoked");
        throw new AuthRequired("The sign-in expired or was revoked");
      }
      const message = (err as Error).message;
      this.backoff.set(name, { until: Date.now() + BACKOFF_MS, message });
      this.setError(name, message);
      throw err;
    }
  }

  private save(name: string, change: (s: OAuthState) => OAuthState) {
    this.store.update(name, (r) => (r.auth.type === "oauth" && r.auth.oauth ? { ...r, auth: { type: "oauth", oauth: change(r.auth.oauth) } } : r));
  }

  setError(name: string, message: string | null) {
    this.store.update(name, (r) => (r.lastError === message || (!r.lastError && !message) ? r : { ...r, lastError: message }));
  }
}
