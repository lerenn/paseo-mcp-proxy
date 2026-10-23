import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { auditEntrySchema, authTypeSchema, serverViewSchema } from "./server";

const listOutput = z.object({
  servers: z.array(serverViewSchema),
  /** Local address agents reach, or null when the port could not be bound. */
  endpoint: z.object({ url: z.string().nullable(), error: z.string().nullable() }),
});

export const listRpc = defineRpc({ name: "mcp-proxy.list", input: z.object({}), output: listOutput });

/** Add a server. The API key (api-key only) is stored and never returned. */
export const addRpc = defineRpc({
  name: "mcp-proxy.add",
  input: z.object({
    name: z.string(),
    url: z.string(),
    auth: authTypeSchema,
    header: z.string().optional(),
    apiKey: z.string().optional(),
    instructions: z.string().optional(),
  }),
  output: z.object({}),
});

export const removeRpc = defineRpc({ name: "mcp-proxy.remove", input: z.object({ name: z.string() }), output: z.object({}) });

export const setKeyRpc = defineRpc({
  name: "mcp-proxy.set-key",
  input: z.object({ name: z.string(), apiKey: z.string() }),
  output: z.object({}),
});

export const setInstructionsRpc = defineRpc({
  name: "mcp-proxy.set-instructions",
  input: z.object({ name: z.string(), instructions: z.string() }),
  output: z.object({}),
});

/** Start the OAuth flow. The screen opens `url` in the user's browser. */
export const signInRpc = defineRpc({
  name: "mcp-proxy.sign-in",
  input: z.object({ name: z.string() }),
  output: z.object({ url: z.string() }),
});

/**
 * Finish a sign-in whose browser could not reach the daemon's callback (a remote daemon): the user
 * pastes the address the browser ended on.
 */
export const completeSignInRpc = defineRpc({
  name: "mcp-proxy.complete-sign-in",
  input: z.object({ name: z.string(), redirectUrl: z.string() }),
  output: z.object({}),
});

export const signOutRpc = defineRpc({ name: "mcp-proxy.sign-out", input: z.object({ name: z.string() }), output: z.object({}) });

/** Open an MCP session upstream to check the credentials work. Returns the outcome in plain words. */
export const testRpc = defineRpc({
  name: "mcp-proxy.test",
  input: z.object({ name: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const auditRpc = defineRpc({
  name: "mcp-proxy.audit",
  input: z.object({ limit: z.number().int().min(1).max(500).default(50) }),
  output: z.object({ entries: z.array(auditEntrySchema) }),
});
