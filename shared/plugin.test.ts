import { describe, expect, it } from "vitest";
import { requestedServers } from "./plugin";

describe("requestedServers", () => {
  it("splits on commas and spaces, lower-cases and de-duplicates", () => {
    expect(requestedServers({ PASEO_MCP_SERVERS: " Linear, sentry  linear,," })).toEqual(["linear", "sentry"]);
  });
  it("is empty when unset", () => {
    expect(requestedServers({})).toEqual([]);
    expect(requestedServers(undefined)).toEqual([]);
  });
  it("keeps * as a name", () => {
    expect(requestedServers({ PASEO_MCP_SERVERS: "*" })).toEqual(["*"]);
  });
});
