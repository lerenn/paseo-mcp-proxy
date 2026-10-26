import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { ZodError } from "zod";
import { definitionSchema, type Definition } from "../shared/definition";
import type { GitSource } from "../shared/settings";
import { sourceLabel } from "./git-sync";
import { DEFAULT_HTTP_HOSTS, validateHeader, validateUrl } from "./validate";

const EXTENSIONS = [".yaml", ".yml", ".json"];

export interface GitDefinition extends Definition {
  /** Short source label, `owner/repo@ref`. */
  origin: string;
}

export interface Problem {
  origin: string;
  file: string;
  message: string;
}

function describe(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ");
  return error instanceof Error ? error.message : String(error);
}

/** Parse one server file; the name must match the file name. */
export function parseDefinition(text: string, file: string, allowHttpHosts: string[] = DEFAULT_HTTP_HOSTS): Definition {
  const definition = definitionSchema.parse(parse(text));
  definition.url = validateUrl(definition.url, allowHttpHosts);
  if (definition.header) definition.header = validateHeader(definition.header);
  const expected = path.basename(file, path.extname(file));
  if (definition.name !== expected) throw new Error(`name "${definition.name}" must match the file name "${expected}"`);
  return definition;
}

/**
 * The server definitions held in the git sources' folders. A snapshot is rebuilt from the local
 * clones after every sync, so a failed sync keeps serving the last good copy. Earlier sources win
 * on a repeated name. Unreadable or invalid files are listed as problems and skipped.
 */
export class GitRegistry {
  private snapshot = new Map<string, GitDefinition>();
  private issues: Problem[] = [];
  private allowHttpHosts = DEFAULT_HTTP_HOSTS;

  /** `dir(source)` is the source's folder inside its local clone. */
  constructor(private readonly dir: (source: GitSource) => string) {}

  reload(sources: GitSource[], allowHttpHosts: string[] = this.allowHttpHosts) {
    this.allowHttpHosts = allowHttpHosts;
    const next = new Map<string, GitDefinition>();
    const issues: Problem[] = [];
    for (const source of sources) {
      const origin = sourceLabel(source);
      let files: string[];
      try {
        files = readdirSync(this.dir(source)).sort();
      } catch (error) {
        // No clone yet (first sync pending or failed): nothing to load, and nothing to complain about here.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push({ origin, file: ".", message: describe(error) });
        continue;
      }
      const seen = new Set<string>();
      for (const base of files) {
        const ext = path.extname(base);
        if (!EXTENSIONS.includes(ext)) continue;
        const stem = path.basename(base, ext);
        if (seen.has(stem)) continue; // .yaml before .yml before .json
        seen.add(stem);
        try {
          const definition = parseDefinition(readFileSync(path.join(this.dir(source), base), "utf8"), base, allowHttpHosts);
          if (!next.has(definition.name)) next.set(definition.name, { ...definition, origin });
        } catch (error) {
          issues.push({ origin, file: base, message: describe(error) });
          console.warn(`mcp-proxy: ignoring ${origin} ${base}: ${describe(error)}`);
        }
      }
    }
    this.snapshot = next;
    this.issues = issues;
  }

  get(name: string): GitDefinition | undefined {
    return this.snapshot.get(name);
  }

  all(): GitDefinition[] {
    return [...this.snapshot.values()];
  }

  problems(): Problem[] {
    return this.issues;
  }
}
