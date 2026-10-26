import path from "node:path";
import { home, readJson, writeJson } from "./files";

export const PENDING_TTL_MS = 10 * 60_000;
/** Several Sign In presses may be in flight for one server; the oldest beyond this are dropped. */
const MAX_PER_SERVER = 10;
const EXPIRED_KEEP_MS = 60 * 60_000;

export interface Pending {
  name: string;
  verifier: string;
  expires: number;
}

interface File {
  pending: Record<string, Pending>;
  /** States of flows that timed out, kept for a while so the error can say "expired" rather than "unknown". */
  expired: Record<string, number>;
}

export const defaultPendingPath = () => path.join(home(), "pending.json");

/**
 * Sign-ins waiting for their browser callback, kept on the daemon in a file (0600, it holds PKCE
 * verifiers) keyed by the `state` nonce. Living outside the process, they survive a plugin reload or
 * daemon restart; each operation re-reads the file, so no other write (settings, secrets, the client
 * panel) can reset them. Any recent Sign In stays valid until it is used, cancelled or past its TTL.
 */
export class PendingStore {
  constructor(private readonly file: string = defaultPendingPath()) {}

  add(state: string, pending: Pending) {
    const data = this.read();
    data.pending[state] = pending;
    const mine = Object.entries(data.pending).filter(([, p]) => p.name === pending.name).sort((a, b) => b[1].expires - a[1].expires);
    for (const [old] of mine.slice(MAX_PER_SERVER)) delete data.pending[old];
    this.write(data);
  }

  get(state: string): Pending | undefined {
    return this.read().pending[state];
  }

  wasExpired(state: string): boolean {
    return state in this.read().expired;
  }

  delete(state: string) {
    const data = this.read();
    if (!(state in data.pending)) return;
    delete data.pending[state];
    this.write(data);
  }

  deleteServer(name: string) {
    const data = this.read();
    let changed = false;
    for (const [state, p] of Object.entries(data.pending)) {
      if (p.name !== name) continue;
      delete data.pending[state];
      changed = true;
    }
    if (changed) this.write(data);
  }

  /** Names of the servers with a live pending sign-in. */
  names(): Set<string> {
    return new Set(Object.values(this.read().pending).map((p) => p.name));
  }

  /** Read, move timed-out flows to `expired`, and persist only when something moved. */
  private read(): File {
    const raw = readJson<Partial<File>>(this.file, {});
    const data: File = { pending: raw.pending ?? {}, expired: raw.expired ?? {} };
    const now = Date.now();
    let changed = false;
    for (const [state, p] of Object.entries(data.pending)) {
      if (p.expires >= now) continue;
      delete data.pending[state];
      data.expired[state] = now;
      changed = true;
    }
    for (const [state, at] of Object.entries(data.expired)) {
      if (now - at <= EXPIRED_KEEP_MS) continue;
      delete data.expired[state];
      changed = true;
    }
    if (changed) this.write(data);
    return data;
  }

  private write(data: File) {
    writeJson(this.file, data);
  }
}
