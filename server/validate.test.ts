import { describe, expect, it } from "vitest";
import { hostMatches, validateUrl } from "./validate";

const CLUSTER = "http://github-mcp.github-mcp.svc.cluster.local:8082/x/all";

describe("validateUrl", () => {
  it("accepts https and loopback http", () => {
    expect(validateUrl("https://mcp.linear.app/mcp")).toBe("https://mcp.linear.app/mcp");
    expect(validateUrl("http://localhost:3000/mcp")).toBe("http://localhost:3000/mcp");
  });

  it("accepts plain http for cluster-internal hosts by default", () => {
    expect(validateUrl(CLUSTER)).toBe(CLUSTER);
    expect(validateUrl("http://github-mcp.github-mcp.svc:8082/x")).toBe("http://github-mcp.github-mcp.svc:8082/x");
  });

  it("rejects plain http for other hosts, including look-alikes", () => {
    expect(() => validateUrl("http://example.com/mcp")).toThrow(/https/);
    expect(() => validateUrl("http://svc.cluster.local.evil.com/mcp")).toThrow(/https/);
    expect(() => validateUrl("http://evilsvc/mcp")).toThrow(/https/);
  });

  it("honours a custom allowHttpHosts list", () => {
    expect(validateUrl("http://mcp.internal/x", ["*.internal"])).toBe("http://mcp.internal/x");
    expect(() => validateUrl(CLUSTER, ["*.internal"])).toThrow(/https/);
    expect(() => validateUrl(CLUSTER, [])).toThrow(/https/);
  });

  it("still rejects credentials in the URL", () => {
    expect(() => validateUrl("http://u:p@a.svc/x")).toThrow(/credentials/);
  });
});

describe("hostMatches", () => {
  it("treats * as a wildcard and everything else literally", () => {
    expect(hostMatches("a.b.svc", "*.svc")).toBe(true);
    expect(hostMatches("axsvc", "*.svc")).toBe(false);
    expect(hostMatches("A.SVC", "*.svc")).toBe(true);
  });
});
