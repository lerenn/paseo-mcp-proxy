import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { McpProxyScreen } from "./client/screen";

function ProxyItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="PlugZap" active={currentScreen?.screenId === "proxy"} onPress={() => openScreen({ screenId: "proxy" })} />;
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "proxy", title: "MCP Proxy", Component: McpProxyScreen });
  client.addSidebarHeaderItem({ id: "proxy", title: "MCP Proxy", Component: ProxyItem });
  return () => {};
}
