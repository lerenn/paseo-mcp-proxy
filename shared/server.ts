import { z } from "zod";

/** Server names appear in URLs and in PASEO_MCP_SERVERS, so keep them to a safe slug. */
export const SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export const authTypeSchema = z.enum(["none", "api-key", "oauth"]);
export type AuthType = z.infer<typeof authTypeSchema>;

export const statusSchema = z.enum(["connected", "needs-sign-in", "error"]);
export type ServerStatus = z.infer<typeof statusSchema>;

/** What the screen may know about a server. Credentials are never part of it. */
export const serverViewSchema = z.object({
  name: z.string(),
  url: z.string(),
  auth: authTypeSchema,
  /** Header that carries the API key (api-key only). */
  header: z.string().nullable(),
  /** Text added to the MCP `instructions` agents see. */
  instructions: z.string(),
  status: statusSchema,
  /** Why the server is in error, or what is missing, in plain words. */
  detail: z.string().nullable(),
  /** A sign-in started from the screen is waiting for the browser. */
  signingIn: z.boolean(),
  /** Short git source label (`owner/repo@ref`) for servers defined in git, which are read-only here; null otherwise. */
  origin: z.string().nullable(),
});
export type ServerView = z.infer<typeof serverViewSchema>;

export const auditEntrySchema = z.object({
  at: z.string(),
  server: z.string(),
  /** JSON-RPC method, or the HTTP method for requests without a body. */
  method: z.string(),
  /** Tool name, for tools/call only. Arguments and results are never logged. */
  tool: z.string().nullable(),
  agentId: z.string().nullable(),
  /** Upstream HTTP status, or 0 when the proxy refused the call before sending it. */
  status: z.number(),
  ok: z.boolean(),
  ms: z.number(),
  /** Short reason for a failure. Never contains credentials. */
  error: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const sourceStatusSchema = z.object({
  /** `owner/repo@ref`. */
  label: z.string(),
  url: z.string(),
  lastSync: z.string().nullable(),
  error: z.string().nullable(),
  syncing: z.boolean(),
});
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

/** A file in a git source that could not be used. */
export const problemSchema = z.object({ origin: z.string(), file: z.string(), message: z.string() });
export type ProblemView = z.infer<typeof problemSchema>;
