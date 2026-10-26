import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_SYNC_MINUTES = 5;

/** A git repository whose folder of server files is mirrored read-only. */
export const gitSourceSchema = z.object({
  /** Anything `git clone` accepts. Credentials come from the daemon's git/SSH setup, not from here. */
  url: z
    .string()
    .trim()
    .min(1)
    .refine((v) => !v.startsWith("-"), "url must not start with '-'"),
  /** Branch or tag. Omit for the remote's default branch. */
  ref: z
    .string()
    .trim()
    .refine((v) => !v.startsWith("-"), "ref must not start with '-'")
    .optional(),
  /** Folder inside the repository that holds the server files. Omit for the repository root. */
  path: z
    .string()
    .trim()
    .refine((v) => !v.split(/[\\/]/).includes(".."), "path must stay inside the repository")
    .refine((v) => !/^([\\/]|[A-Za-z]:)/.test(v), "path must be relative")
    .optional(),
  intervalMinutes: z.number().int().min(1).default(DEFAULT_SYNC_MINUTES),
});
export type GitSource = z.output<typeof gitSourceSchema>;

/** Where the server registry is read from, and which servers new agents get. Holds no secret: URLs, folders and names only. */
export const sourcesSettings = defineSettings({
  id: "sources",
  scope: "host",
  version: 1,
  schema: z.object({
    sources: z.array(gitSourceSchema).default([]),
    /** Registry names (comma or space separated) or `*` attached to every new agent that does not set PASEO_MCP_SERVERS. Empty: none. */
    defaultServers: z.string().default(""),
    /** Host globs (`*` matches any run of characters) whose servers may use plain http://. Loopback is always allowed. */
    allowHttpHosts: z.array(z.string().trim().min(1)).default(["*.svc", "*.svc.cluster.local"]),
  }),
});
