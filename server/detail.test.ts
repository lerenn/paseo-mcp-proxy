import { describe, expect, it } from "vitest";
import { upstreamDetail } from "./service";

describe("upstreamDetail", () => {
  it("reads a JSON-RPC error message", () => {
    expect(upstreamDetail('{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"App is not enabled for MCP server access."}}')).toBe("App is not enabled for MCP server access.");
  });
  it("reads Slack and OAuth style errors", () => {
    expect(upstreamDetail('{"ok":false,"error":"invalid_auth"}')).toBe("invalid_auth");
    expect(upstreamDetail('{"error":"invalid_request","error_description":"bad scope"}')).toBe("invalid_request - bad scope");
  });
  it("removes tokens, codes and secrets", () => {
    const out = upstreamDetail('{"error":"bad xoxp-123-abc Bearer abc.def code=zzz9 and 0123456789abcdef0123456789abcdef0123"}');
    expect(out).not.toMatch(/xoxp|abc\.def|zzz9|0123456789abcdef/);
  });
  it("trims plain text and HTML", () => {
    expect(upstreamDetail("<html><b>Bad</b>  request</html>")).toBe("Bad request");
    expect(upstreamDetail("x".repeat(10) + " ".repeat(5) + "y".repeat(500)).length).toBeLessThanOrEqual(300);
  });
});
