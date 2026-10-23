import { rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitSources, sourceLabel } from "./git-sync";
import { GitRegistry } from "./registry";
import { ProxyService } from "./service";
import { ServerStore } from "./store";
import { makeOrigin, tmp } from "./testing";
import { Credentials } from "./upstream";

const LINEAR = `name: linear\nurl: https://mcp.linear.app/mcp\nauth: oauth\ninstructions: |\n  Use team ANY.\n`;
const SENTRY = `name: sentry\nurl: https://mcp.sentry.dev/mcp\nauth: api-key\nheader: X-Sentry-Key\n`;

async function setup(files: Record<string, string>) {
  const origin = await makeOrigin(files);
  const source = { url: origin.bare, ref: "main", path: "servers", intervalMinutes: 5 };
  const root = tmp();
  let sources = [source];
  const gitSources = new GitSources(path.join(root, "git"), undefined, undefined, () => registry.reload(sources));
  const registry = new GitRegistry((s) => gitSources.serversDir(s));
  const store = new ServerStore(registry, path.join(root, "servers.json"), path.join(root, "secrets.json"));
  const service = new ProxyService(store, new Credentials(store), () => "http://127.0.0.1:1");
  return { ...origin, source, root, gitSources, registry, store, service, setSources: (s: typeof sources) => (sources = s) };
}

describe("git-defined servers", () => {
  it("loads servers from the synced folder, labelled and read-only", async () => {
    const t = await setup({ "linear.yaml": LINEAR, "sentry.yml": SENTRY });
    await t.gitSources.sync(t.source);
    const views = t.service.views();
    expect(views.map((v) => [v.name, v.auth, v.origin, v.header, v.instructions.trim()])).toEqual([
      ["linear", "oauth", sourceLabel(t.source), null, "Use team ANY."],
      ["sentry", "api-key", sourceLabel(t.source), "X-Sentry-Key", ""],
    ]);
    expect(() => t.service.remove("linear")).toThrow(/managed in git/);
    expect(() => t.service.setInstructions("linear", "x")).toThrow(/managed in git/);
    expect(() => t.service.add({ name: "linear", url: "https://x.example/mcp", auth: "none" })).toThrow(/already exists/);
  });

  it("keeps API keys on the daemon, keyed by name, never in the git clone or the views", async () => {
    const t = await setup({ "sentry.yml": SENTRY });
    await t.gitSources.sync(t.source);
    t.service.setKey("sentry", "sk-live-secret");
    expect(t.store.get("sentry")!.auth).toMatchObject({ type: "api-key", header: "X-Sentry-Key", key: "sk-live-secret" });
    expect(statSync(path.join(t.root, "secrets.json")).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(t.service.views())).not.toContain("sk-live-secret");
    expect(JSON.stringify(t.registry.all())).not.toContain("sk-live-secret");
    // The key survives a sync that changes the definition's notes.
    await t.commit({ "sentry.yml": `${SENTRY}instructions: new notes\n` }, "notes");
    await t.gitSources.sync(t.source);
    expect(t.store.get("sentry")!.auth).toMatchObject({ key: "sk-live-secret" });
    expect(t.store.get("sentry")!.instructions).toBe("new notes");
  });

  it("stops using stored credentials when git points the name at another URL", async () => {
    const t = await setup({ "sentry.yml": SENTRY });
    await t.gitSources.sync(t.source);
    t.service.setKey("sentry", "sk-live-secret");
    await t.commit({ "sentry.yml": SENTRY.replace("mcp.sentry.dev", "evil.example") }, "move");
    await t.gitSources.sync(t.source);
    expect(t.store.get("sentry")!.auth).toMatchObject({ type: "api-key", key: null });
    expect(t.service.views()[0].status).toBe("needs-sign-in");
  });

  it("keeps serving the last good copy when a sync fails", async () => {
    const t = await setup({ "linear.yaml": LINEAR });
    await t.gitSources.sync(t.source);
    rmSync(t.bare, { recursive: true });
    const status = await t.gitSources.sync(t.source);
    expect(status.error).toBeTruthy();
    expect(t.store.get("linear")).not.toBeNull();
  });

  it("reports invalid files and rejects secrets in them, without dropping valid ones", async () => {
    const t = await setup({
      "linear.yaml": LINEAR,
      "leaky.yaml": "name: leaky\nurl: https://x.example/mcp\nauth: api-key\nkey: sk-oops\n",
      "wrong.yaml": "name: other\nurl: https://x.example/mcp\nauth: none\n",
      "plain.yaml": "name: plain\nurl: http://example.com/mcp\nauth: none\n",
    });
    await t.gitSources.sync(t.source);
    expect(t.store.names()).toEqual(["linear"]);
    const problems = t.registry.problems();
    expect(problems.map((p) => p.file).sort()).toEqual(["leaky.yaml", "plain.yaml", "wrong.yaml"]);
    expect(problems.find((p) => p.file === "leaky.yaml")!.message).toMatch(/key/);
    expect(JSON.stringify(problems)).not.toContain("sk-oops");
  });

  it("lets git win over a server added on the screen, and earlier sources win over later ones", async () => {
    const t = await setup({ "linear.yaml": LINEAR });
    t.service.add({ name: "local", url: "https://l.example/mcp", auth: "none" });
    writeFileSync(path.join(t.root, "unused"), "");
    await t.gitSources.sync(t.source);
    expect(t.service.views().map((v) => [v.name, v.origin])).toEqual([["linear", sourceLabel(t.source)], ["local", null]]);
    t.service.remove("local");
    expect(t.store.names()).toEqual(["linear"]);
  });
});

describe("sourceLabel", () => {
  it("shortens GitHub URLs to owner/repo@ref", () => {
    expect(sourceLabel({ url: "git@github.com:anyshift-io/lfradin-lab.git", ref: "main" })).toBe("anyshift-io/lfradin-lab@main");
    expect(sourceLabel({ url: "https://github.com/a/b.git" })).toBe("a/b@HEAD");
  });
});
