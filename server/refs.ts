import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Read a value a definition points to: `env:NAME` or `file:<path>#<key>` (JSON file, dotted key, `~/`
 * expands to the daemon user's home). Errors name the reference, never the value.
 */
export function resolveRef(ref: string): string {
  if (ref.startsWith("env:")) {
    const value = process.env[ref.slice(4)];
    if (!value?.trim()) throw new Error(`${ref} is not set on the daemon`);
    return value.trim();
  }
  const hash = ref.lastIndexOf("#");
  const file = ref.slice("file:".length, hash);
  const key = ref.slice(hash + 1);
  const resolved = file.startsWith("~/") ? path.join(homedir(), file.slice(2)) : file;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "does not exist" : error instanceof SyntaxError ? "is not valid JSON" : "cannot be read";
    throw new Error(`${file} ${reason} (needed by ${ref})`);
  }
  let value: unknown = json;
  for (const part of key.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${file} has no string field "${key}" (needed by ${ref})`);
  return value.trim();
}
