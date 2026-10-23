import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export const tmp = () => mkdtempSync(path.join(tmpdir(), "mcpp-"));

export interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** A throwaway local HTTP server. `handler` answers; every request is recorded in `seen`. */
export async function listen(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void | Promise<void>) {
  const seen: Seen[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() };
    seen.push(entry);
    await handler(req, res, entry);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

export const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString();

/** A bare origin whose `servers/` folder holds the given files on branch main, plus a clone to push changes from. */
export async function makeOrigin(files: Record<string, string>) {
  const bare = tmp();
  git(bare, "init", "-q", "--bare", "-b", "main");
  const work = tmp();
  git(work, "clone", "-q", bare, ".");
  git(work, "checkout", "-q", "-b", "main");
  const commit = async (next: Record<string, string>, message: string) => {
    await mkdir(path.join(work, "servers"), { recursive: true });
    for (const [file, text] of Object.entries(next)) await writeFile(path.join(work, "servers", file), text);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", message);
    git(work, "push", "-q", "origin", "main");
  };
  await commit(files, "init");
  return { bare, work, commit };
}
