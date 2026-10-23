import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { auditEntrySchema, type AuditEntry } from "../shared/server";
import { home } from "./files";

const MAX_BYTES = 5_000_000;

/** Append-only record of proxied calls: who, which server, which tool, outcome. No payloads. Mode 0600; one rotation. */
export class AuditLog {
  constructor(private readonly file: string = path.join(home(), "audit.jsonl")) {}

  record(entry: Omit<AuditEntry, "at">) {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) renameSync(this.file, `${this.file}.1`);
      const fresh = !existsSync(this.file);
      appendFileSync(this.file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
      if (fresh) chmodSync(this.file, 0o600);
    } catch (err) {
      console.error(`mcp-proxy: cannot write audit log: ${(err as Error).message}`);
    }
  }

  /** Newest first. */
  recent(limit = 50): AuditEntry[] {
    let text = "";
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    const out: AuditEntry[] = [];
    for (const line of text.split("\n").reverse()) {
      if (!line) continue;
      let json: unknown = null;
      try {
        json = JSON.parse(line);
      } catch {}
      const parsed = auditEntrySchema.safeParse(json);
      if (parsed.success) out.push(parsed.data);
      if (out.length >= limit) break;
    }
    return out;
  }
}
