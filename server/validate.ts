import { SERVER_NAME } from "../shared/server";

export function validateName(name: string): string {
  const clean = name.trim().toLowerCase();
  if (!SERVER_NAME.test(clean)) throw new Error("Names are lowercase letters, digits and dashes, starting with a letter (32 characters at most)");
  return clean;
}

/** Only http(s) URLs; plain http is allowed for loopback so local servers can be proxied too. */
export function validateUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Not a valid URL");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("The URL must start with https:// (http:// is only accepted for localhost)");
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
