import { openExternalUrl, useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { SettingsInput } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { addRpc, auditRpc, completeSignInRpc, listRpc, removeRpc, setInstructionsRpc, setKeyRpc, signInRpc, signOutRpc, syncRpc, testRpc } from "../shared/rpc";
import { DEFAULT_SYNC_MINUTES, gitSourceSchema, sourcesSettings, type GitSource } from "../shared/settings";
import type { AuditEntry, AuthType, ProblemView, ServerView, SourceStatus } from "../shared/server";

const LIST_KEY = ["mcp-proxy", "list"];
const AUDIT_KEY = ["mcp-proxy", "audit"];

const AUTH_LABEL: Record<AuthType, string> = { none: "No authentication", "api-key": "API key", oauth: "OAuth" };

export function McpProxyScreen({ theme, layout }: PluginScreenProps) {
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const list = useRpc(listRpc);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: LIST_KEY,
    queryFn: () => list({}),
    // Poll faster while a browser sign-in is pending, so the row flips as soon as the callback lands.
    refetchInterval: (q) => (q.state.data?.servers.some((s) => s.signingIn) ? 2_000 : 15_000),
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: LIST_KEY });
  const servers = query.data?.servers ?? [];
  const [adding, setAdding] = useState(false);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>MCP Proxy</Text>
      <Text style={styles.muted}>
        Agents use these MCP servers without ever holding the keys or sign-ins. They are kept on this machine and never shown again.
      </Text>
      {query.data?.endpoint.error ? <Text style={styles.error}>{query.data.endpoint.error}</Text> : null}
      {query.error ? <Text style={styles.error}>{(query.error as Error).message}</Text> : null}

      <View style={styles.rows}>
        {servers.length === 0 ? <Text style={[styles.muted, styles.pad]}>No servers yet.</Text> : null}
        {servers.map((s, i) => <ServerRow key={s.name} server={s} first={i === 0} styles={styles} theme={theme} onChanged={reload} />)}
      </View>
      {adding ? <AddForm styles={styles} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} /> : <Button styles={styles} label="Add Server" onPress={() => setAdding(true)} />}

      <Sources styles={styles} sources={query.data?.sources ?? []} problems={query.data?.problems ?? []} onChanged={reload} />
      <Activity styles={styles} />
      <Text style={styles.muted}>
        Servers marked with a repository are defined in git and read-only here; only their keys and sign-ins are set here.
        Give an agent a server by creating it with PASEO_MCP_SERVERS=name1,name2 (or *) in its environment.
        The proxy listens on {query.data?.endpoint.url ?? "no address"} on this machine only.
      </Text>
    </ScrollView>
  );
}

type Theme = PluginScreenProps["theme"];

function statusColor(status: ServerView["status"], theme: Theme): string {
  return status === "connected" ? theme.colors.statusSuccess : status === "error" ? theme.colors.statusDanger : theme.colors.statusWarning;
}

function ServerRow({ server, first, styles, theme, onChanged }: { server: ServerView; first: boolean; styles: Styles; theme: Theme; onChanged(): void }) {
  const signIn = useRpc(signInRpc);
  const signOut = useRpc(signOutRpc);
  const remove = useRpc(removeRpc);
  const test = useRpc(testRpc);
  const [panel, setPanel] = useState<"key" | "paste" | "instructions" | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const run = (fn: () => Promise<unknown>) => fn().then(onChanged, (e) => setNote({ text: (e as Error).message, bad: true }));
  const toggle = (p: "key" | "paste" | "instructions") => setPanel((cur) => (cur === p ? null : p));
  const color = statusColor(server.status, theme);
  const statusText = server.status === "connected" ? "Connected" : server.status === "error" ? "Error" : server.auth === "api-key" ? "Needs Key" : "Needs Sign-In";

  return (
    <View style={[styles.row, !first && styles.divider]}>
      <View style={styles.line}>
        <View style={styles.nameBox}>
          <View accessibilityLabel={`Status: ${statusText}`} style={[styles.dot, { backgroundColor: color }]} />
          <Text style={styles.name} numberOfLines={1}>{server.name}</Text>
          <Text style={styles.badge}>{AUTH_LABEL[server.auth]}</Text>
          {server.origin ? <Text style={styles.badge} accessibilityLabel={`Defined in git: ${server.origin}`}>{server.origin}</Text> : null}
        </View>
        <View style={styles.actions}>
          {server.auth === "oauth" ? (
            <>
              <Button styles={styles} small primary={server.status === "needs-sign-in"} label={server.status === "needs-sign-in" ? "Sign In" : "Sign In Again"} onPress={() => run(async () => { setNote(null); const { url } = await signIn({ name: server.name }); await openExternalUrl(url); setNote({ text: "Finish in your browser. If it cannot reach this machine, use Paste Address.", bad: false }); })} />
              <Button styles={styles} small label="Paste Address" onPress={() => toggle("paste")} />
              {server.status !== "needs-sign-in" ? <Button styles={styles} small label="Sign Out" onPress={() => run(() => signOut({ name: server.name }))} /> : null}
            </>
          ) : null}
          {server.auth === "api-key" ? <Button styles={styles} small label="Replace Key" onPress={() => toggle("key")} /> : null}
          <Button styles={styles} small label="Test" onPress={() => run(async () => { const r = await test({ name: server.name }); setNote({ text: r.message, bad: !r.ok }); })} />
          {server.origin ? null : <Button styles={styles} small label="Notes" onPress={() => toggle("instructions")} />}
          {server.origin ? null : <Button styles={styles} small label="Remove" onPress={() => run(() => remove({ name: server.name }))} />}
        </View>
      </View>
      <Text style={styles.muted} numberOfLines={1}>{server.url}</Text>
      {server.detail ? <Text style={styles.error}>{server.detail}</Text> : null}
      {note ? <Text style={note.bad ? styles.error : styles.muted}>{note.text}</Text> : null}
      {panel === "key" ? <KeyForm styles={styles} name={server.name} onDone={() => { setPanel(null); onChanged(); }} onCancel={() => setPanel(null)} /> : null}
      {panel === "paste" ? <PasteForm styles={styles} name={server.name} onDone={() => { setPanel(null); onChanged(); }} onCancel={() => setPanel(null)} /> : null}
      {panel === "instructions" ? <InstructionsForm styles={styles} server={server} onDone={() => { setPanel(null); onChanged(); }} onCancel={() => setPanel(null)} /> : null}
    </View>
  );
}


function KeyForm({ styles, name, onDone, onCancel }: { styles: Styles; name: string; onDone(): void; onCancel(): void }) {
  const setKey = useRpc(setKeyRpc);
  const [key, setValue] = useState("");
  const save = useMutation({ mutationFn: () => setKey({ name, apiKey: key }), onSuccess: () => { setValue(""); onDone(); } });
  return (
    <View style={styles.form}>
      <TextInput style={styles.input} value={key} onChangeText={setValue} placeholder={`New key for ${name}`} placeholderTextColor={styles.placeholder.color} secureTextEntry autoCapitalize="none" autoCorrect={false} accessibilityLabel="API key" />
      {save.error ? <Text style={styles.error}>{(save.error as Error).message}</Text> : null}
      <View style={styles.actions}>
        <Button styles={styles} small primary disabled={!key.trim() || save.isPending} label="Save" onPress={() => save.mutate()} />
        <Button styles={styles} small label="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}

/** For a daemon the browser cannot reach: the address the browser ended on carries the code. */
function PasteForm({ styles, name, onDone, onCancel }: { styles: Styles; name: string; onDone(): void; onCancel(): void }) {
  const complete = useRpc(completeSignInRpc);
  const [url, setUrl] = useState("");
  const save = useMutation({ mutationFn: () => complete({ name, redirectUrl: url }), onSuccess: onDone });
  return (
    <View style={styles.form}>
      <Text style={styles.muted}>After approving in the browser, the page may fail to load. Copy its full address (it starts with http://127.0.0.1) and paste it here.</Text>
      <TextInput style={styles.input} value={url} onChangeText={setUrl} placeholder="http://127.0.0.1:47824/oauth/callback?code=…" placeholderTextColor={styles.placeholder.color} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Address the browser ended on" />
      {save.error ? <Text style={styles.error}>{(save.error as Error).message}</Text> : null}
      <View style={styles.actions}>
        <Button styles={styles} small primary disabled={!url.trim() || save.isPending} label={save.isPending ? "Finishing…" : "Finish Sign-In"} onPress={() => save.mutate()} />
        <Button styles={styles} small label="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}

/** Text added to what the server tells agents about itself. */
function InstructionsForm({ styles, server, onDone, onCancel }: { styles: Styles; server: ServerView; onDone(): void; onCancel(): void }) {
  const set = useRpc(setInstructionsRpc);
  const [text, setText] = useState(server.instructions);
  const save = useMutation({ mutationFn: () => set({ name: server.name, instructions: text }), onSuccess: onDone });
  return (
    <View style={styles.form}>
      <Text style={styles.muted}>Shown to agents with this server, for example which workspace or project to use.</Text>
      <TextInput style={[styles.input, styles.multiline]} value={text} onChangeText={setText} multiline placeholder="Notes for agents" placeholderTextColor={styles.placeholder.color} accessibilityLabel="Notes for agents" />
      {save.error ? <Text style={styles.error}>{(save.error as Error).message}</Text> : null}
      <View style={styles.actions}>
        <Button styles={styles} small primary disabled={save.isPending} label="Save" onPress={() => save.mutate()} />
        <Button styles={styles} small label="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}

const AUTHS: AuthType[] = ["oauth", "api-key", "none"];

function AddForm({ styles, onCancel, onSaved }: { styles: Styles; onCancel(): void; onSaved(): void }) {
  const add = useRpc(addRpc);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<AuthType>("oauth");
  const [header, setHeader] = useState("");
  const [apiKey, setApiKey] = useState("");
  const ready = name.trim() && url.trim() && (auth !== "api-key" || apiKey.trim());
  const save = useMutation({
    mutationFn: () => add({ name, url, auth, header: auth === "api-key" ? header : undefined, apiKey: auth === "api-key" ? apiKey : undefined }),
    onSuccess: () => { setApiKey(""); onSaved(); },
  });
  const field = (props: React.ComponentProps<typeof TextInput>) => <TextInput {...props} style={styles.input} placeholderTextColor={styles.placeholder.color} autoCapitalize="none" autoCorrect={false} />;
  return (
    <View style={styles.panel}>
      <Text style={styles.heading}>Add Server</Text>
      {field({ value: name, onChangeText: setName, placeholder: "Name, e.g. linear", accessibilityLabel: "Server name" })}
      {field({ value: url, onChangeText: setUrl, placeholder: "URL, e.g. https://mcp.linear.app/mcp", accessibilityLabel: "Server URL" })}
      <View style={styles.actions}>
        {AUTHS.map((a) => (
          <Pressable key={a} accessibilityRole="radio" accessibilityState={{ selected: auth === a }} onPress={() => setAuth(a)} style={[styles.choice, auth === a && styles.choiceSelected]}>
            <Text style={styles.value}>{AUTH_LABEL[a]}</Text>
          </Pressable>
        ))}
      </View>
      {auth === "api-key" ? (
        <>
          {field({ value: header, onChangeText: setHeader, placeholder: "Header (default Authorization)", accessibilityLabel: "Header name" })}
          {field({ value: apiKey, onChangeText: setApiKey, placeholder: "API key", secureTextEntry: true, accessibilityLabel: "API key" })}
        </>
      ) : null}
      {auth === "oauth" ? <Text style={styles.muted}>After adding, press Sign In on the server's row.</Text> : null}
      {save.error ? <Text style={styles.error}>{(save.error as Error).message}</Text> : null}
      <View style={styles.actions}>
        <Button styles={styles} small primary disabled={!ready || save.isPending} label="Add" onPress={() => save.mutate()} />
        <Button styles={styles} small label="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}

type Draft = { id: number; url: string; ref: string; path: string; interval: string };

function ago(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

/** Git sources hold the server registry as files; they are mirrored read-only with the daemon's own git credentials. */
function Sources({ styles, sources, problems, onChanged }: { styles: Styles; sources: SourceStatus[]; problems: ProblemView[]; onChanged(): void }) {
  const settings = useSettings(sourcesSettings);
  const sync = useRpc(syncRpc);
  const nextId = useRef(0);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const syncNow = useMutation({ mutationFn: () => sync({}), onSuccess: onChanged });

  const toDrafts = (list: GitSource[]): Draft[] => list.map((s) => ({ id: nextId.current++, url: s.url, ref: s.ref ?? "", path: s.path ?? "", interval: String(s.intervalMinutes) }));
  useEffect(() => {
    if (drafts === null && settings.status === "ready") setDrafts(toDrafts(settings.values.sources));
  }, [drafts, settings]);
  const edit = (id: number, patch: Partial<Draft>) => setDrafts((list) => (list ?? []).map((d) => (d.id === id ? { ...d, ...patch } : d)));

  async function save() {
    if (settings.status !== "ready" || !drafts) return;
    const parsed: GitSource[] = [];
    for (const d of drafts) {
      const result = gitSourceSchema.safeParse({ url: d.url, ref: d.ref.trim() || undefined, path: d.path.trim() || undefined, intervalMinutes: d.interval.trim() ? Number(d.interval) : DEFAULT_SYNC_MINUTES });
      if (!result.success) return setError(`${d.url || "New source"}: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      parsed.push(result.data);
    }
    setError(null);
    if (await settings.save({ ...settings.values, sources: parsed }, settings.revision)) {
      setDrafts(null);
      onChanged();
    }
  }

  return (
    <View style={styles.panel}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel="Git Sources" onPress={() => setOpen((v) => !v)}>
        <Text style={styles.heading}>{open ? "▾ Git Sources" : "▸ Git Sources"}{sources.length ? ` (${sources.length})` : ""}</Text>
      </Pressable>
      {sources.map((s) => (
        <Text key={`${s.url}-${s.label}`} style={s.error ? styles.error : styles.muted}>
          {s.label}: {s.syncing ? "syncing…" : `synced ${ago(s.lastSync)}`}{s.error ? `. Last sync failed, using the previous copy: ${s.error}` : ""}
        </Text>
      ))}
      {problems.map((p) => <Text key={`${p.origin}/${p.file}`} style={styles.error}>{p.origin} {p.file}: {p.message}</Text>)}
      {open ? (
        <View style={styles.form}>
          <Text style={styles.muted}>
            Each file in the folder defines one server: name, url, auth (none, api-key or oauth), optional header and instructions. Never put a key in it.
            The repository is cloned with the daemon's own git credentials.
          </Text>
          {settings.status === "invalid" || settings.status === "error" ? <Text style={styles.error}>{settings.error}</Text> : null}
          {(drafts ?? []).map((d) => (
            <View key={d.id} style={styles.form}>
              <SettingsInput label="Repository URL" initialValue={d.url} onChangeText={(url) => edit(d.id, { url })} placeholder="git@github.com:owner/repo.git" />
              <SettingsInput label="Branch or tag (optional)" initialValue={d.ref} onChangeText={(ref) => edit(d.id, { ref })} placeholder="default branch" />
              <SettingsInput label="Folder (optional)" initialValue={d.path} onChangeText={(path) => edit(d.id, { path })} placeholder="mcp-servers" />
              <SettingsInput label="Sync interval (minutes)" initialValue={d.interval} onChangeText={(interval) => edit(d.id, { interval })} placeholder={String(DEFAULT_SYNC_MINUTES)} />
              <Button styles={styles} small label="Remove Source" onPress={() => setDrafts((list) => (list ?? []).filter((x) => x.id !== d.id))} />
            </View>
          ))}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {settings.status === "ready" && settings.saveError ? <Text style={styles.error}>{settings.saveError}</Text> : null}
          {syncNow.error ? <Text style={styles.error}>{(syncNow.error as Error).message}</Text> : null}
          <View style={styles.actions}>
            <Button styles={styles} small label="Add Source" onPress={() => setDrafts((list) => [...(list ?? []), { id: nextId.current++, url: "", ref: "", path: "", interval: String(DEFAULT_SYNC_MINUTES) }])} />
            <Button styles={styles} small primary label={settings.status === "ready" && settings.saving ? "Saving…" : "Save Sources"} onPress={save} />
            <Button styles={styles} small label={syncNow.isPending ? "Syncing…" : "Sync Now"} onPress={() => syncNow.mutate()} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Activity({ styles }: { styles: Styles }) {
  const audit = useRpc(auditRpc);
  const query = useQuery({ queryKey: AUDIT_KEY, queryFn: () => audit({ limit: 20 }), refetchInterval: 10_000 });
  const entries = query.data?.entries ?? [];
  return (
    <View style={styles.panel}>
      <Text style={styles.heading}>Recent Calls</Text>
      {entries.length === 0 ? <Text style={styles.muted}>Nothing yet. Agents' calls appear here, without their contents.</Text> : null}
      {entries.length ? <View style={styles.rows}>{entries.map((e, i) => <AuditRow key={`${e.at}-${i}`} entry={e} first={i === 0} styles={styles} />)}</View> : null}
    </View>
  );
}

function AuditRow({ entry, first, styles }: { entry: AuditEntry; first: boolean; styles: Styles }) {
  const what = entry.tool ? `${entry.server} · ${entry.tool}` : `${entry.server} · ${entry.method}`;
  return (
    <View style={[styles.row, !first && styles.divider]}>
      <View style={styles.line}>
        <View style={styles.nameBox}>
          <Text style={[styles.badge, entry.ok ? null : styles.badgeBad]}>{entry.ok ? "OK" : entry.status ? `HTTP ${entry.status}` : "Refused"}</Text>
          <Text style={styles.value} numberOfLines={1}>{what}</Text>
        </View>
        <Text style={styles.muted}>{new Date(entry.at).toLocaleTimeString()} · {entry.ms} ms</Text>
      </View>
      <Text style={styles.muted} numberOfLines={1}>{entry.agentId ? `Agent ${entry.agentId.slice(0, 8)}` : "Unknown agent"}{entry.error ? ` · ${entry.error}` : ""}</Text>
    </View>
  );
}

function Button({ styles, label, onPress, primary, small, disabled }: { styles: Styles; label: string; onPress(): void; primary?: boolean; small?: boolean; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress} style={[styles.button, small && styles.buttonSmall, primary && styles.buttonPrimary, disabled && styles.buttonDisabled]}>
      <Text style={[primary ? styles.buttonPrimaryText : styles.buttonText, small && styles.buttonSmallText]}>{label}</Text>
    </Pressable>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(theme: Theme, compact: boolean) {
  const pad = compact ? 16 : 24;
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: pad, gap: 14 },
    title: { color: theme.colors.foreground, fontSize: compact ? 20 : 24 },
    heading: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
    name: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
    muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
    value: { color: theme.colors.foreground, fontSize: 14, flexShrink: 1 },
    error: { color: theme.colors.foregroundMuted, fontSize: 13, fontStyle: "italic" as const },
    badge: { color: theme.colors.foregroundMuted, fontSize: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
    badgeBad: { color: theme.colors.statusDanger, borderColor: theme.colors.statusDanger },
    dot: { width: 10, height: 10, borderRadius: 5 },
    pad: { padding: 12 },
    panel: { gap: 10, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
    rows: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, backgroundColor: theme.colors.surface0 },
    row: { gap: 6, paddingVertical: 10, paddingHorizontal: 12 },
    divider: { borderTopWidth: 1, borderTopColor: theme.colors.border },
    line: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 12, flexWrap: "wrap" as const },
    nameBox: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexShrink: 1 },
    actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
    form: { gap: 8, paddingTop: 2 },
    placeholder: { color: theme.colors.foregroundMuted },
    input: { minHeight: 36, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2, color: theme.colors.foreground, fontSize: 14 },
    multiline: { minHeight: 80, textAlignVertical: "top" as const },
    choice: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border },
    choiceSelected: { borderColor: theme.colors.accent },
    button: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, alignSelf: "flex-start" as const },
    buttonSmall: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6 },
    buttonSmallText: { fontSize: 13 },
    buttonDisabled: { opacity: 0.5 },
    buttonPrimary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    buttonText: { color: theme.colors.foreground, fontSize: 14 },
    buttonPrimaryText: { color: theme.colors.accentForeground, fontSize: 14 },
  };
}
