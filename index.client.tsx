import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { hostBadgeComponent } from "./client/host-badge";
import { McpProxyScreen } from "./client/screen";

const HostBadge = hostBadgeComponent();

function ProxyItem({ currentScreen, openScreen, host }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      // `subtitle` is newer than the pinned plugin types, hence the spread.
      {...(HostBadge ? { subtitle: <HostBadge hostId={host.id} /> } : {})}
      icon="PlugZap"
      active={currentScreen?.screenId === "proxy"}
      onPress={() => openScreen({ screenId: "proxy" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "proxy", title: "MCP Proxy", Component: McpProxyScreen });
  client.addSidebarHeaderItem({ id: "proxy", title: "MCP Proxy", Component: ProxyItem });
  return () => {};
}
