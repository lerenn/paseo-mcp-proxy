import { z } from "zod";
import { authTypeSchema, SERVER_NAME } from "./server";

/**
 * One server as it is written in a git file: everything except secrets. API keys, OAuth client
 * secrets and refresh tokens never appear here; they are set on the daemon, keyed by the name.
 * Unknown fields are rejected, so a `key:` or `token:` line fails loudly instead of being ignored.
 */
export const definitionSchema = z
  .object({
    /** Schema version, optional. */
    version: z.literal(1).optional(),
    name: z.string().regex(SERVER_NAME, "lowercase letters, digits and dashes, starting with a letter (32 at most)"),
    url: z.string().trim().min(1),
    auth: authTypeSchema,
    /** Header that carries the API key; default Authorization. Only with auth: api-key. */
    header: z.string().trim().min(1).optional(),
    /** Text added to the MCP instructions agents see. */
    instructions: z.string().optional(),
  })
  .strict()
  .refine((d) => d.auth === "api-key" || d.header === undefined, { path: ["header"], message: "only applies to auth: api-key" });
export type Definition = z.output<typeof definitionSchema>;
