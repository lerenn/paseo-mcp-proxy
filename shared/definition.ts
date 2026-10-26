import { z } from "zod";
import { authTypeSchema, displayNameSchema, SERVER_NAME } from "./server";

/**
 * Where a daemon-side value is read from: `file:<path>#<key>` (a JSON file; `~/` is the daemon user's home,
 * `key` may be dotted for nested fields) or `env:<NAME>`. The value itself never appears in a definition.
 */
export const REF = /^(env:[A-Za-z_][A-Za-z0-9_]*|file:[^#\s][^#]*#[^#\s]+)$/;
const refSchema = z.string().trim().regex(REF, "expected file:<path>#<key> or env:<NAME>");

/** A pre-registered OAuth client, for servers without dynamic client registration. */
export const oauthClientSchema = z
  .object({
    clientIdRef: refSchema,
    /** Omit for a public client. */
    clientSecretRef: refSchema.optional(),
    /** Requested instead of whatever the server advertises. Omit to request the advertised scopes. */
    scopes: z.array(z.string().trim().min(1).regex(/^\S+$/, "no spaces in a scope")).min(1).optional(),
    /** How the secret is sent to the token endpoint; default client_secret_post (client_secret_basic, or none for a public client). */
    tokenEndpointAuth: z.enum(["client_secret_post", "client_secret_basic", "none"]).optional(),
  })
  .strict()
  .refine((c) => c.tokenEndpointAuth === "none" || c.tokenEndpointAuth === undefined || c.clientSecretRef !== undefined, { path: ["clientSecretRef"], message: "required with this tokenEndpointAuth" });
export type OAuthClient = z.output<typeof oauthClientSchema>;

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
    /** Label for the screen, shown instead of the name. Agents never see it. */
    displayName: displayNameSchema.optional(),
    url: z.string().trim().min(1),
    auth: authTypeSchema,
    /** Header that carries the API key; default Authorization. Only with auth: api-key. */
    header: z.string().trim().min(1).optional(),
    /** Pre-registered OAuth client (references only). Only with auth: oauth. */
    oauthClient: oauthClientSchema.optional(),
    /** Text added to the MCP instructions agents see. */
    instructions: z.string().optional(),
  })
  .strict()
  .refine((d) => d.auth === "oauth" || d.oauthClient === undefined, { path: ["oauthClient"], message: "only applies to auth: oauth" })
  .refine((d) => d.auth === "api-key" || d.header === undefined, { path: ["header"], message: "only applies to auth: api-key" });
export type Definition = z.output<typeof definitionSchema>;
