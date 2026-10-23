import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const home = () => path.join(homedir(), ".paseo", "mcp-proxy");

/** Read a JSON file, or `fallback` when it is missing or unreadable. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write JSON atomically, readable only by the daemon's user (file 0600, directory 0700). */
export function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** An AbortSignal that fires after `ms`; the timer does not keep the process alive. */
export function timeout(ms: number): NonNullable<RequestInit["signal"]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms) as unknown as { unref?(): void };
  timer.unref?.();
  return controller.signal as NonNullable<RequestInit["signal"]>;
}
