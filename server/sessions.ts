import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { home, readJson, writeJson } from "./files";

export interface AgentSession {
  /** Servers this agent was granted at creation, lower-case. */
  servers: string[];
  /** Bound when the agent's session opens. */
  agentId?: string;
  createdAt: number;
}

const UNBOUND_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * Per-agent capability tokens. They only tell agents apart and bound which servers each may reach;
 * they carry no upstream access. Persisted so agents resumed after a daemon restart keep working.
 */
export class SessionStore {
  private sessions: Record<string, AgentSession>;

  constructor(private readonly file: string = path.join(home(), "sessions.json")) {
    this.sessions = readJson(this.file, {});
    this.prune();
  }

  create(servers: string[]): string {
    const token = randomBytes(24).toString("base64url");
    this.sessions[token] = { servers, createdAt: Date.now() };
    writeJson(this.file, this.sessions);
    return token;
  }

  /** Constant-time lookup. */
  resolve(token: string | undefined): AgentSession | null {
    if (!token) return null;
    const candidate = Buffer.from(token);
    let found: AgentSession | null = null;
    for (const [known, session] of Object.entries(this.sessions)) {
      const k = Buffer.from(known);
      if (k.length === candidate.length && timingSafeEqual(k, candidate)) found = session;
    }
    return found;
  }

  bind(token: string, agentId: string): boolean {
    const session = this.sessions[token];
    if (!session) return false;
    session.agentId = agentId;
    writeJson(this.file, this.sessions);
    return true;
  }

  forgetAgent(agentId: string) {
    for (const [token, session] of Object.entries(this.sessions)) if (session.agentId === agentId) delete this.sessions[token];
    writeJson(this.file, this.sessions);
  }

  private prune() {
    const cutoff = Date.now() - UNBOUND_TTL_MS;
    let changed = false;
    for (const [token, session] of Object.entries(this.sessions)) {
      if (!session.agentId && session.createdAt < cutoff) {
        delete this.sessions[token];
        changed = true;
      }
    }
    if (changed) writeJson(this.file, this.sessions);
  }
}
