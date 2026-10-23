import type { PluginServerContext } from "@getpaseo/plugin/server";
import { AuditLog } from "./server/audit";
import { GitSources } from "./server/git-sync";
import { GitRegistry } from "./server/registry";
import { attachServers } from "./server/attach";
import { ProxyHttp } from "./server/proxy";
import { ProxyService } from "./server/service";
import { SessionStore } from "./server/sessions";
import { ServerStore } from "./server/store";
import { Credentials } from "./server/upstream";
import { CAPABILITY_ENV, SERVERS_ENV } from "./shared/plugin";
import { addRpc, auditRpc, completeSignInRpc, listRpc, removeRpc, setInstructionsRpc, setKeyRpc, signInRpc, signOutRpc, syncRpc, testRpc } from "./shared/rpc";
import { sourcesSettings, type GitSource } from "./shared/settings";
import { sourceLabel } from "./server/git-sync";

const DEFAULT_PORT = 47824;

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(sourcesSettings);
  let sources: GitSource[] = [];
  const gitSources = new GitSources(undefined, undefined, undefined, () => registry.reload(sources));
  const registry = new GitRegistry((source) => gitSources.serversDir(source));
  const store = new ServerStore(registry);
  const sessions = new SessionStore();
  const audit = new AuditLog();
  const creds = new Credentials(store);

  let url: string | null = null;
  let startError: string | null = null;
  const service = new ProxyService(store, creds, () => url);
  const http = new ProxyHttp({ store, sessions, creds, audit, onCallback: (params) => service.finishSignIn(params) });

  // Servers defined in git are available as soon as the settings are read, from the last good clones;
  // the first fetch then refreshes them.
  const apply = (next: GitSource[]) => {
    sources = next;
    registry.reload(sources);
    gitSources.configure(sources);
  };
  const loaded = settings.read().then((state) => apply(state.status === "ready" ? state.values.sources : []));
  const unsubscribe = settings.subscribe((state) => apply(state.status === "ready" ? state.values.sources : []));

  // Resumed agents keep the URL they were created with, so the port has to be stable.
  const port = Number(process.env.MCP_PROXY_PORT ?? DEFAULT_PORT);
  const started = http.start(port).then(
    (u) => {
      url = u;
    },
    (err: Error) => {
      startError = `mcp-proxy cannot listen on 127.0.0.1:${port}: ${err.message}. Set MCP_PROXY_PORT on the daemon.`;
      console.error(startError);
    },
  );

  const removeCreate = server.before("agent.create", async ({ request }) => {
    // Agents that did not ask for servers are left exactly as they are.
    if (!request.env?.[SERVERS_ENV]) return;
    await Promise.all([started, loaded]);
    // Refuse rather than start an agent that silently lacks the servers its role depends on.
    if (!url) throw new Error(`${startError} Create the agent without PASEO_MCP_SERVERS to skip MCP Proxy.`);
    return attachServers(request, { url, registered: store.names(), capability: (granted) => sessions.create(granted) });
  });
  const removeOpen = server.before("agent.session_open", ({ request }) => {
    const capability = request.env[CAPABILITY_ENV];
    if (capability) sessions.bind(capability, request.agentId);
  });
  const removeArchived = server.on("agent.archived", ({ agent }) => sessions.forgetAgent(agent.id));

  const listing = () => ({
    servers: service.views(),
    endpoint: { url, error: startError },
    sources: sources.map((source) => ({ label: sourceLabel(source), url: source.url, ...gitSources.status(source) })),
    problems: registry.problems(),
  });
  server.handle(listRpc, listing);
  server.handle(syncRpc, async () => (await gitSources.syncAll(sources), listing()));
  server.handle(addRpc, (input) => (service.add(input), {}));
  server.handle(removeRpc, ({ name }) => (service.remove(name), {}));
  server.handle(setKeyRpc, ({ name, apiKey }) => (service.setKey(name, apiKey), {}));
  server.handle(setInstructionsRpc, ({ name, instructions }) => (service.setInstructions(name, instructions), {}));
  server.handle(signInRpc, async ({ name }) => ({ url: await service.signIn(name) }));
  server.handle(completeSignInRpc, async ({ name, redirectUrl }) => (await service.completeSignIn(name, redirectUrl), {}));
  server.handle(signOutRpc, ({ name }) => (service.signOut(name), {}));
  server.handle(testRpc, ({ name }) => service.test(name));
  server.handle(auditRpc, ({ limit }) => ({ entries: audit.recent(limit) }));

  return async () => {
    removeCreate();
    removeOpen();
    removeArchived();
    unsubscribe();
    gitSources.stop();
    await http.stop();
  };
}
