import { SERVER_NAME } from "../shared/server";

export function validateName(name: string): string {
  const clean = name.trim().toLowerCase();
  if (!SERVER_NAME.test(clean)) throw new Error("Names are lowercase letters, digits and dashes, starting with a letter (32 characters at most)");
  return clean;
}

/** Hosts that may be reached over plain http by default: the cluster-internal service names. */
export const DEFAULT_HTTP_HOSTS = ["*.svc", "*.svc.cluster.local"];

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** Match a hostname against a glob where `*` stands for any run of characters. */
export function hostMatches(host: string, glob: string): boolean {
  const pattern = glob.trim().toLowerCase().split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${pattern}$`).test(host.toLowerCase());
}

/** Only http(s) URLs; plain http is allowed for loopback and for hosts matching `allowHttpHosts` (cluster-internal by default). */
export function validateUrl(raw: string, allowHttpHosts: string[] = DEFAULT_HTTP_HOSTS): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Not a valid URL");
  }
  const plainHttpOk = LOOPBACK.includes(url.hostname) || allowHttpHosts.some((glob) => hostMatches(url.hostname, glob));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && plainHttpOk)) throw new Error(`The URL must start with https:// (http:// is only accepted for localhost and ${allowHttpHosts.join(", ") || "no other host"})`);
  if (url.username || url.password) throw new Error("Do not put credentials in the URL");
  url.hash = "";
  return url.toString();
}

const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function validateHeader(header: string): string {
  const clean = header.trim();
  if (!HEADER.test(clean)) throw new Error("Not a valid header name");
  if (/^(host|content-type|content-length|accept|mcp-session-id|mcp-protocol-version|cookie)$/i.test(clean)) throw new Error(`${clean} cannot carry an API key`);
  return clean;
}
