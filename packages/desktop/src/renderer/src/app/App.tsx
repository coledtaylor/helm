import type { JSX, ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Harness } from "@helm/core";
import {
  activateTab,
  activeRef,
  besideOf,
  browserSearchName,
  closeGroup,
  closeTab,
  cycleTab,
  DEFAULT_SETTINGS,
  familiesHere,
  familyOf,
  findTab,
  focusGroup,
  fromSaved,
  groupById,
  hostOf,
  isChild,
  isLoopbackUrl,
  isSessionOn,
  isProjectPinned,
  isScanRoot,
  liveSessionsIn,
  moveTab,
  notOpenHere,
  openFile,
  openTab,
  openTabWithPreview,
  paneId,
  paneRects,
  placeBeside,
  placeIn,
  placeRestored,
  replaceSessionTabs,
  reconcile,
  resizeSplit,
  returnsToFamily,
  savedGroups,
  sendBeside,
  sessionLabel,
  sessionRef,
  sessionTabIds,
  splitWith,
  toSaved,
  withProjectPinned,
  isPluginRailId,
  pluginRailId,
  retitleTab,
  activatePluginPage,
  closePluginPage,
  frontPluginPage,
  isPluginPageId,
  movePluginPage,
  openPluginPageIds,
  placePluginPage,
  pluginPageId,
  pluginPagesId,
  retitlePluginSurface,
  RAIL_DESTINATIONS,
  LOCAL_HOST_KEY,
  LOCAL_HOST_LABEL,
  failedLastLine,
  lineToTryByHand,
  localHostVersions,
  restartHostDetail,
  restartHostConfirmTone,
  restartHostQuestion,
  quitChoice,
  quitEndsSessions,
  withoutRemoteHost,
  type RemoteHost,
  type PluginParams,
  type PluginPagesRef,
  type EditorHighlight,
  type FileRef,
  type HistorySession,
  type LiveSession,
  type PaneGroup as PaneGroupState,
  type PaneLayout,
  type PaneRef,
  type Profile,
  type ProfileDraft,
  type Project,
  type RailItemId,
  type RestoreOffer,
  type SavedPaneLayout,
  type SessionRecord,
} from "@helm/core/types";
import {
  AppShell,
  BROWSER_ZOOM,
  BrowserPages,
  BrowserPane,
  cn,
  CodeIcon,
  CommandPalette,
  EyeIcon,
  ExternalIcon,
  LinkIcon,
  ListIcon,
  PencilIcon,
  PinIcon,
  PluginIcon,
  PluginPage,
  PluginPages,
  PluginsPage,
  SearchIcon,
  PluginSessionDialog,
  SecretDialog,
  SecretsPage,
  TrashIcon,
  pluginSection,
  type PaletteCommand,
  type SecretPluginChoice,
  type StatusPluginItem,
  ConfigConsole,
  ConfigDeleteDialog,
  ConfigDeletedNotice,
  ConfigEditor,
  ConfigNewDialog,
  ConfigNothingSelected,
  ConfigRenameDialog,
  ConfirmSessionDialog,
  type ConsoleEntry,
  DocIcon,
  EffectiveViewPane,
  FileActions,
  FileCrumb,
  FilesRootPicker,
  FilesStatusNote,
  FilesTree,
  FileView,
  FolderIcon,
  FolderPlusIcon,
  GearIcon,
  GlobeIcon,
  HarnessIcon,
  HealthPanel,
  HistoryIcon,
  ImportIcon,
  LayersIcon,
  McpPanel,
  NewHarnessDialog,
  NewSessionDialog,
  NewTabMenu,
  hasPrimaryModifier,
  hostOs,
  isMac,
  overlayOpen,
  PaneActions,
  PaneCrumb,
  PaneDrop,
  PaneGrid,
  PaneGroup,
  PlusIcon,
  ProfileEditor,
  ProfileList,
  ProjectPane,
  QuickOpenDialog,
  Rail,
  RAIL_ICON,
  RefreshIcon,
  RepoIcon,
  RestorePane,
  SaveAsTemplateDialog,
  SessionHistory,
  SessionsPane,
  SessionTree,
  sessionTreeHostProps,
  SettingsPane,
  SettingsSections,
  SetupPane,
  Sidebar,
  shortcutLabel,
  SidebarAction,
  SlidersIcon,
  StatusBar,
  TabBar,
  TemplateManager,
  TerminalIcon,
  ConsoleIcon,
  TitleBar,
  VersionBanner,
  OwnDataBanner,
  HostStoppedBanner,
  WelcomePane,
  type LaunchChoice,
  type PaneDropZone,
  type ProfilePrediction,
  type QuickOpenAt,
  type QuickOpenMode,
  type RailItem,
  type SettingsSectionId,
  type Tab,
  type TabIndicator,
  type MenuEntry,
  type TreeReveal,
  type TreeSession,
  type TreeHost,
  type LauncherHost,
  type HostChoice,
  type HostInstallActions,
  AddHostDialog,
  type AddHostActions,
} from "@helm/ui";
import { sidebarFor, type SidebarView } from "./sidebarFor";
import { pressTreeSession, treeEntries } from "./treeFamilies";
import type { PanelActionIcon } from "@coledtaylor/helm-plugin-sdk";
import type {
  AppMode,
  PluginInfo,
  PluginUiRequest,
} from "../../../shared/ipc";
import {
  browserKeyCommand,
  COMMANDS_THAT_REPEAT,
  type BrowserCommand,
} from "../../../shared/browserKeys";
import { hostFrameKey, hostLabel } from "../../../shared/plugins/origin";
import {
  bridgeFor,
  devices,
  eachHostBridge,
  helm,
  hostSessionTabs,
  hostState,
  seenHostVersion,
  localHostConnection,
  reconnectLocalHost,
  remoteHosts as remoteHostLinks,
} from "./bridge";
import { useDevicesSettings } from "./useDevicesSettings";
import { useForwardedPorts } from "./useForwardedPorts";
import { LOCAL_HOST_NAME } from "./host/sessions";
import { ProjectColumn } from "./ProjectColumn";
import { disposeShell, terminalShellKey } from "./pterms";
import { disposeTerminal, estimateGrid } from "./terminals";
import { readable } from "./errors";
import { TerminalPane, type HostLost } from "./TerminalPane";
import { TerminalTabPane } from "./TerminalTabPane";
import { terminalFontStack } from "../terminal";
import {
  crumbStatus,
  indicatorOf,
  sessionNote,
  statusCounts as countSessionStates,
  statusHint,
  useNow,
} from "./sessionView";
import { useConfig } from "./useConfig";
import {
  DocumentModeSwitch,
  DocumentTab,
  documentKind,
  type DocumentMode,
} from "./DocumentTab";
import { fileKey, joinRoot, relativeTo, useFiles } from "./useFiles";
import { sessionHistoryProps, useHistory } from "./useHistory";
import { useLauncher } from "./useLauncher";
import { useProfiles } from "./useProfiles";
import { useLiveSessions } from "./useLiveSessions";
import { useNewSession } from "./useNewSession";
import { useRestore } from "./useRestore";
import { useRestartHost, type RestartHostDeps } from "./useRestartHost";
import { useSessions } from "./useSessions";
import { LocalProjectPane } from "./LocalProjectPane";
import { sessionActivityIn } from "./useAgentWorktrees";
import { useSetup } from "./useSetup";
import { useHostWorkspaces } from "./useHostWorkspaces";
import { HostProfiles } from "./HostProfiles";
import { useTemplates } from "./useTemplates";
import { useThemes } from "./useThemes";
import { useBrowsers } from "./useBrowsers";
import { useShells } from "./useShells";
import { treeLaunchNotice, type TreeLaunchFailure } from "./launchNotice";
import {
  closeKeepingRunning,
  keepRemoteTab,
  useSessionConfirm,
  useShownSessionTabs,
  type FamilyScope,
} from "./hostTabs";
import { familyCapacity, useFamilyRoomOf } from "./familyRooms";
import { stopChild } from "./familyActions";
import { FamilyTab, type FamilyKid } from "./FamilyTab";
import { useUpdate } from "./useUpdate";
import { useOwnDataCopy } from "./useOwnDataCopy";
import { useUsage } from "./useUsage";
import { useHostPlugins, usePlugins } from "./usePlugins";
import { PluginFrame, PluginsUnavailable } from "./PluginFrame";
import {
  disposePluginFrames,
  emitToPluginFrame,
  queueToPluginFrame,
  setPluginFrameHooks,
} from "./pluginFrames";
import { usePluginSettings } from "./usePluginSettings";
import type { SurfaceSpec } from "../plugins/relay";

const KIND_ICON = {
  harness: HarnessIcon,
  repo: RepoIcon,
  folder: FolderIcon,
} as const;

/**
 * A link in a rendered note, handed to the OS browser.
 *
 * Not a hook, because it holds nothing. The renderer's navigation posture is
 * unchanged by the browser pane and is the reason this exists at all:
 * `will-navigate` is still prevented on this window and its window-open handler
 * still denies, so the only thing an `https://` link in a document can do is
 * ask main to open it somewhere else. What the browser pane added is a set of
 * `WebContentsView`s that are exempt **by id**, in `main/index.ts`; this window
 * is not one of them and never will be.
 */
const helmOpenExternal = (url: string): Promise<{ opened: boolean }> =>
  helm.invoke("shell:openExternal", { url });

/** Settings > Hosts' check, install and cancel on a host's computer: main runs them, through that host's own transport. */
const hostInstall: HostInstallActions = {
  check: (target) => helm.invoke("remoteHosts:check", target),
  install: (id, host) => helm.invoke("remoteHosts:install", { id, host }),
  cancel: (id) => void helm.invoke("remoteHosts:cancel", { id }),
};

/**
 * The add-a-host dialog's reads, checks and adds: main reads this computer's
 * ssh config Host names, checks and installs through the user's own ssh or
 * command, and adds a host only once it connected.
 */
const addHostActions: AddHostActions = {
  sshHosts: () => helm.invoke("remoteHosts:sshHosts"),
  wslDistros: () => helm.invoke("remoteHosts:wslDistros"),
  check: hostInstall.check,
  install: hostInstall.install,
  cancelInstall: hostInstall.cancel,
  add: (request) => helm.invoke("remoteHosts:add", request),
  cancelAdd: (attempt) =>
    void helm.invoke("remoteHosts:cancelAdd", { attempt }),
};

/** A stable empty list, so a view with no console entries does not hand
 * `BrowserPane` a fresh array to re-render against on every render. */
const EMPTY_CONSOLE: ConsoleEntry[] = [];
/** The Browser tab: one, however many pages it holds. */
const BROWSER_TAB = { kind: "browser" } as const;

/** The same, for a project with nothing running in it - which is most of them. */
const EMPTY_LIVE: LiveSession[] = [];
const EMPTY_PROJECTS: Project[] = [];

/**
 * The editors' tokeniser, on the far side of an IPC boundary.
 *
 * A module-level constant rather than a `useCallback`, and that is load-bearing
 * rather than tidy: the editor debounces on this identity, so a new function
 * per render of `App` would cancel and restart the debounce on every render the
 * app happens to do. Nothing here closes over state.
 */
const helmHighlight = (
  path: string,
  source: string,
): Promise<EditorHighlight> =>
  helm.invoke("editor:highlight", { path, source });

/**
 * What each build mode is called on the status bar, and null for the one that
 * needs no word. `dev-live` is the dev build with **no data directory of its
 * own**, sharing `%APPDATA%\Helm` with the installed app, and the chip that says
 * so is the only thing on screen that distinguishes it from an ordinary
 * `pnpm dev`.
 */
const MODE_LABEL: Record<AppMode, string | null> = {
  installed: null,
  portable: "portable",
  dev: "dev",
  "dev-live": "dev · live",
};

/**
 * A tab label, cut to what a pill can hold.
 *
 * Cut here rather than left to `text-overflow`, because the label is a number
 * and a title glued together and the number is the half that identifies it.
 */
const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/**
 * The folder a tab is about, for a launcher to open on: a project tab's, a
 * file's root, or a session's project - or its folder, for a session no project
 * was recorded against, such as a profile's at a harness root.
 */
function folderOf(
  ref: PaneRef | null,
  sessionsById: ReadonlyMap<number, SessionRecord>,
  remoteSession: (host: string, id: number) => SessionRecord | undefined = () =>
    undefined,
): string | null {
  if (ref?.kind === "project" || ref?.kind === "terminal") return ref.path;
  if (ref?.kind === "file") return ref.root;
  if (ref?.kind !== "session") return null;
  const host = hostOf(ref);
  const session =
    host === LOCAL_HOST_KEY
      ? sessionsById.get(ref.id)
      : remoteSession(host, ref.id);
  return session === undefined ? null : (session.projectPath ?? session.cwd);
}

/** A panel header action's glyph, by the name the manifest gives it. */
const PANEL_ACTION_ICON: Record<
  PanelActionIcon,
  (props: { width: number; height: number }) => JSX.Element
> = {
  refresh: RefreshIcon,
  plus: PlusIcon,
  search: SearchIcon,
  list: ListIcon,
  settings: GearIcon,
  external: ExternalIcon,
  pin: PinIcon,
  edit: PencilIcon,
  trash: TrashIcon,
  link: LinkIcon,
  eye: EyeIcon,
};

const NO_PLUGINS: ReadonlyMap<string, PluginInfo> = new Map();

/** A plugin's request, with the host whose plugin made it. */
type OnHost<T> = T & { host: string };

/** The surfaces that show one host's data at a time, with a switch while more than one is connected. */
type HostSurface = "history" | "usage" | "config" | "files" | "plugins";
const LOCAL_SURFACES: Readonly<Record<HostSurface, string>> = {
  history: LOCAL_HOST_KEY,
  usage: LOCAL_HOST_KEY,
  config: LOCAL_HOST_KEY,
  files: LOCAL_HOST_KEY,
  plugins: LOCAL_HOST_KEY,
};

/**
 * The sidebar view of a plugin's rail panel: `plugin:<id>` for this PC's, as
 * it always was, and `plugin:<id>.<host label>` for a remote host's. A plugin
 * id holds no dot, so the two never meet.
 */
function railViewOf(host: string, id: string): SidebarView {
  return host === LOCAL_HOST_KEY
    ? pluginRailId(id)
    : `plugin:${id}.${hostLabel(host)}`;
}

/** The surface a plugin's rail icon opens: its rail panel on its host, as the relay knows it. */
function railPanelSpec(
  id: string,
  plugin: PluginInfo,
  host: string = LOCAL_HOST_KEY,
): SurfaceSpec | null {
  if (plugin.rail === null) return null;
  const panel = plugin.panels[plugin.rail.panel];
  if (panel === undefined) return null;
  return {
    key: hostFrameKey(host, `panel:${id}/${plugin.rail.panel}`),
    plugin: id,
    ...(host === LOCAL_HOST_KEY ? {} : { host }),
    revision: plugin.revision,
    url: panel.url,
    surface: "panel",
    name: plugin.rail.panel,
    params: {},
    title: panel.title,
  };
}

/**
 * The frame key of a plugin tab: its pane id on its host, with the host named
 * the way every plugin frame names one (`hostFrameKey`).
 */
function pluginTabKey(ref: Extract<PaneRef, { kind: "plugin" }>): string {
  const { host, ...here } = ref;
  return hostFrameKey(host, paneId(here));
}

/** What a page in a plugin's strip is called: the title it was given, or its tab's in the manifest. */
/** The second line of a preview tab's hover text. */
const PREVIEW_HINT = "Preview - double-click to keep it open";

/** The strip previews with `plugin`'s set to `page`, or taken away (null). */
function withPreview(
  previews: ReadonlyMap<string, string>,
  plugin: string,
  page: string | null,
): ReadonlyMap<string, string> {
  if ((previews.get(plugin) ?? null) === page) return previews;
  const next = new Map(previews);
  if (page === null) next.delete(plugin);
  else next.set(plugin, page);
  return next;
}

/** The strip previews with `page` no longer `plugin`'s preview, if it was. */
function withoutPreview(
  previews: ReadonlyMap<string, string>,
  plugin: string,
  page: string,
): ReadonlyMap<string, string> {
  return previews.get(plugin) === page
    ? withPreview(previews, plugin, null)
    : previews;
}

function pluginPageTitle(
  page: PluginPagesRef["pages"][number],
  plugin: PluginInfo,
): string {
  return page.title ?? plugin.tabs[page.tab]?.title ?? page.tab;
}

/** The session id inside a `session:12` tab id. */
const sessionIdOf = (id: string): number => Number(id.slice("session:".length));

/** The session tab menu's Close tab, keep running. */
const KEEP_RUNNING = "keep-running";
/** Every host's bridge, for the question a host asks before a running session's tab closes. */
const HOST_BRIDGES = { each: eachHostBridge, bridgeFor };

/** The last segment of a path, for a session in no project the scan found. */
const folderName = (path: string): string =>
  path
    .split(/[\\/]+/)
    .filter((part) => part !== "")
    .at(-1) ?? path;

/** Settings > Devices' reach: the devices store and the window's own connection to each host. */
const DEVICES_DEPS = {
  devices,
  localConnection: localHostConnection,
  remoteConnection: (id: string) => remoteHostLinks.connection(id),
};

/** No remote hosts, as one value so a hook's input does not change every render. */
const NO_HOSTS: readonly RemoteHost[] = [];

export function App(): JSX.Element {
  const launcher = useLauncher();
  /**
   * Show in Explorer for a path on `host`: this PC's file manager shows this
   * PC's folders only, so a surface showing a host on another computer offers
   * none rather than a button that does nothing.
   */
  const revealOn = (host: string): ((path: string) => void) | undefined =>
    host === LOCAL_HOST_KEY ? launcher.reveal : undefined;
  const { discovery, settings, info } = launcher;

  /**
   * The panes, or null while they are still the saved ones.
   *
   * Null and not the empty layout because the two are different states:
   * nothing has been arranged this run, versus every tab has been closed. Only
   * the first should fall back to what the last launch left behind.
   *
   * Restoring is therefore a *derivation* (`open`, below) rather than an effect
   * that copies the setting into state once it lands. The settings arrive over
   * IPC a moment after the first paint, so a sync would render the empty window
   * first and the real one after.
   */
  const [layout, setLayout] = useState<PaneLayout | null>(null);
  /** The pane given the whole window, by its group's id, or null for the arrangement. */
  const [maximized, setMaximized] = useState<number | null>(null);
  /**
   * The tab being dragged out of a strip, or null. Every pane's drop zones
   * wake for the length of the gesture, and need to know which tab it is to
   * say which zones would do anything.
   */
  const [draggingTab, setDraggingTab] = useState<string | null>(null);
  /**
   * A pane's `+` was pressed and what it opened is on screen: which pane (its
   * group's id), the
   * button it hangs from, and the folder that pane is about, read once when it
   * opened.
   */
  const [newTab, setNewTab] = useState<{
    group: number;
    anchor: HTMLElement;
    folder: string | null;
    /** The host it opens on: the pane's front tab's while connected, else this PC. */
    host: string;
  } | null>(null);
  /**
   * The file tab standing as a preview - opened by a single click, replaced by
   * the next one (`openFile`). Not written down: a restart reopens it as an
   * ordinary tab, which is what a tab that survived a restart is.
   */
  const [preview, setPreview] = useState<string | null>(null);
  /**
   * The page standing as the preview in each plugin's strip, by plugin
   * (`placePluginPage`). A strip's preview is its own, apart from the pane's.
   * Not written down, for the reason `preview` is not.
   */
  const [pagePreviews, setPagePreviews] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  /** Ctrl+P, open on this project, or null. */
  const [quickOpenRoot, setQuickOpenRoot] = useState<string | null>(null);
  /** Which half of it: names (Ctrl+P) or text (Ctrl+Shift+F). */
  const [quickOpenMode, setQuickOpenMode] = useState<QuickOpenMode>("files");
  /**
   * A note's Preview / Source / Edit, by file key. Absent is Preview. Kept per
   * file rather than per tab, so a note closed in Source opens in Source.
   */
  const [docModes, setDocModes] = useState<ReadonlyMap<string, DocumentMode>>(
    new Map(),
  );
  /** Notes with a draft that is not on disk - the tab strip's dot. */
  const [docDirty, setDocDirty] = useState<ReadonlySet<string>>(new Set());
  /** Where a file opened from a text search lands, by file key: the line and the words. */
  const [fileReveals, setFileReveals] = useState<
    ReadonlyMap<string, QuickOpenAt>
  >(new Map());
  /** The section of Settings in the pane; the sidebar lists the rest. */
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("general");
  /** A host whose floti the sidebar asked to update, which Settings > Hosts starts on. */
  const [hostUpdateRequest, setHostUpdateRequest] = useState<{
    id: string;
    nonce: number;
  } | null>(null);
  /** Whether the add-a-host dialog is open, from Settings > Hosts or the sidebar. */
  const [addingHost, setAddingHost] = useState(false);
  /** Where each file tab's caret is, so VS Code opens at the same line. */
  const fileCarets = useRef(new Map<string, number>());
  const [sidebarView, setSidebarView] = useState<SidebarView>("sessions");
  const pluginState = usePlugins();
  /** The plugins that are on, by id: only these have tabs, panels and rail icons. */
  const plugins = pluginState.live;
  /** Plugins' secret requests, answered one dialog at a time, in order, each on the host whose plugin asked. */
  const [secretAsks, setSecretAsks] = useState<
    OnHost<Extract<PluginUiRequest, { kind: "secret" }>>[]
  >([]);
  /** Sessions plugins asked to start, put to the user one dialog at a time, in order, each on its plugin's host. */
  const [sessionAsks, setSessionAsks] = useState<
    OnHost<Extract<PluginUiRequest, { kind: "session" }>>[]
  >([]);
  /** The front one's launch: under way, or why it did not start. */
  const [sessionAskState, setSessionAskState] = useState<{
    busy: boolean;
    error: string | null;
  }>({ busy: false, error: null });
  /** Ctrl+Shift+P. */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** The rail's current view, pressed again, puts the sidebar away. */
  const [sidebarHidden, setSidebarHidden] = useState(false);
  /** The last tab click's row, for the Sessions tree to bring into view. */
  const [treeReveal, setTreeReveal] = useState<TreeReveal | null>(null);
  /** Bumped when a file tab is clicked: the Files tree scrolls to its row. */
  const [filesRevealSeq, setFilesRevealSeq] = useState<number | undefined>(
    undefined,
  );
  const revealCount = useRef(0);
  /** The project a session is starting in, from its page or its `+`. */
  const [launchingPath, setLaunchingPath] = useState<string | null>(null);
  /**
   * The row the sessions pane has open, by pid - the one key a session Helm
   * does not host also has. Held here rather than in the pane because a pane
   * can be thrown away and rebuilt at will, and a selection that unmounted with
   * it would drop whenever somebody looked at another tab.
   */
  const [selectedLivePid, setSelectedLivePid] = useState<number | null>(null);
  /** Each pane's body by its group's id, measured to open a pty at roughly the right grid. */
  const bodyRefs = useRef(new Map<number, HTMLDivElement>());

  const profileState = useProfiles();
  const newSession = useNewSession();
  /** The launcher's host's profiles, read through its bridge while the launcher is on another host. */
  const launcherProfiles = useProfiles(newSession.host);
  // Whether the window has its host: lost from a crash until it is back.
  const hostLink = useSyncExternalStore(hostState.subscribe, hostState.get);
  const seenLocalVersion = useSyncExternalStore(
    seenHostVersion.subscribe,
    seenHostVersion.get,
  );
  /** Which of this PC's host and this Helm is behind, while they differ (`localHostVersions`). */
  const localVersions =
    seenLocalVersion === null || info === null
      ? null
      : localHostVersions(seenLocalVersion, info.version);
  // Each host on another computer: where its link stands and what runs there.
  // A remote host's drop is its own and shows no host-stopped notice.
  const remoteView = useSyncExternalStore(
    remoteHostLinks.subscribe,
    remoteHostLinks.get,
  );
  /** The hosts on other computers this device has added, kept in its own settings. */
  const listedHosts = useMemo(() => settings?.hosts ?? NO_HOSTS, [settings]);
  const listedHostIds = useMemo(
    () => listedHosts.map((host) => host.id),
    [listedHosts],
  );
  const connectedHostIds = useMemo(
    () =>
      listedHostIds.filter(
        (id) => remoteView[id]?.connection?.state === "connected",
      ),
    [listedHostIds, remoteView],
  );
  /** What the window has read of each: its folders, pins and sessions, each through its own bridge. */
  const hostWork = useHostWorkspaces(listedHostIds, connectedHostIds);
  /** Each connected host's plugins, read through its own bridge: the rail lists their panels after this PC's. */
  const remotePlugins = useHostPlugins(connectedHostIds);
  /** A remote host's plugins that are on, by id; none for a host not connected. */
  const pluginsOn = useCallback(
    (host: string): ReadonlyMap<string, PluginInfo> =>
      host === LOCAL_HOST_KEY
        ? plugins
        : (remotePlugins.get(host)?.live ?? NO_PLUGINS),
    [plugins, remotePlugins],
  );
  /** The hosts a launch can go to: this PC, then each connected host on another computer. */
  const launcherHosts: LauncherHost[] = useMemo(
    () => [
      { id: LOCAL_HOST_KEY, name: LOCAL_HOST_LABEL, remote: false },
      ...listedHosts
        .filter((host) => connectedHostIds.includes(host.id))
        .map((host) => ({ id: host.id, name: host.name, remote: true })),
    ],
    [listedHosts, connectedHostIds],
  );
  const hostName = useCallback(
    (host: string): string =>
      host === LOCAL_HOST_KEY
        ? LOCAL_HOST_LABEL
        : (listedHosts.find((each) => each.id === host)?.name ?? host),
    [listedHosts],
  );
  /**
   * What the window shows while main's link to a host on another computer is
   * down: the host's name, the last line its ssh or command wrote when it
   * could not get in (null while it is only trying again), and the line to
   * try by hand. Null for This PC, for a host connected, and for one nothing
   * has been heard from yet.
   */
  const hostAway = useCallback(
    (host: string): HostLost | null => {
      if (host === LOCAL_HOST_KEY) return null;
      const listed = listedHosts.find((each) => each.id === host);
      const connection = remoteView[host]?.connection ?? null;
      if (
        listed === undefined ||
        connection === null ||
        connection.state === "connected"
      )
        return null;
      return {
        hostName: listed.name,
        lastLine: failedLastLine(connection),
        tryLine: lineToTryByHand(listed),
        onReconnect: () => remoteHostLinks.reconnect(host),
      };
    },
    [listedHosts, remoteView],
  );
  // Asked again each time the window gets its host back: the new host offers what the old one lost.
  const restoreState = useRestore(hostLink.reconnects);
  const {
    offer: restoreOffer,
    restore: restoreLost,
    dismiss: dismissRestore,
  } = restoreState;
  /**
   * The host History, Usage, Config, Files and Settings > Plugins each show:
   * kept in this window only and sent to no host, This PC until switched. A
   * host removed from this device's list falls back to This PC; one that is
   * listed but not connected stays chosen, and its surface says why it cannot
   * be read rather than showing another host's.
   */
  const [surfaceHosts, setSurfaceHosts] =
    useState<Readonly<Record<HostSurface, string>>>(LOCAL_SURFACES);
  /** A project's Config or Files asked for while that surface showed another host, pointed once it shows this PC. */
  const [pendingScope, setPendingScope] = useState<{
    surface: "config" | "files";
    path: string;
    host: string;
  } | null>(null);
  const shownHostOf = (surface: HostSurface): string => {
    const chosen = surfaceHosts[surface];
    return chosen === LOCAL_HOST_KEY || listedHostIds.includes(chosen)
      ? chosen
      : LOCAL_HOST_KEY;
  };
  const historyHost = shownHostOf("history");
  const usageHost = shownHostOf("usage");
  const configHost = shownHostOf("config");
  const filesHost = shownHostOf("files");
  const pluginsHost = shownHostOf("plugins");
  const showHostOn = useCallback(
    (surface: HostSurface, host: string) =>
      setSurfaceHosts((current) =>
        current[surface] === host ? current : { ...current, [surface]: host },
      ),
    [],
  );
  /**
   * A surface's host switch: This PC and each connected host, and the one it
   * shows when that has dropped. Absent while there is only one to choose,
   * which leaves the surface as it always was.
   */
  const hostChoiceFor = (surface: HostSurface): HostChoice | undefined => {
    const host = shownHostOf(surface);
    const hosts = launcherHosts.some((each) => each.id === host)
      ? launcherHosts
      : [...launcherHosts, { id: host, name: hostName(host), remote: true }];
    return hosts.length < 2
      ? undefined
      : { hosts, host, onHostChange: (next) => showHostOn(surface, next) };
  };
  const historyState = useHistory(historyHost);
  const configState = useConfig(configHost);
  const usage = useUsage(usageHost);
  const check = useUpdate();
  const ownData = useOwnDataCopy();
  const themes = useThemes();
  /*
   * Every live session on the machine, and what Helm's own are holding. Held
   * here rather than inside the sessions pane because the tree and the launch
   * warning need it whether or not that pane has ever been opened.
   */
  const machineSessions = useLiveSessions();
  /**
   * From `answered` and not `attempted`: the bar's line is a standing fact - a
   * newer release exists - and a manual check that could not reach GitHub is
   * not evidence against it. The settings pane takes `attempted` instead.
   */
  const answered = check.answered;
  const update =
    answered !== null &&
    answered.newer &&
    answered.latest !== null &&
    answered.url !== null
      ? { latest: answered.latest, newer: true, url: answered.url }
      : null;
  /** Late-bound for the reason `focusSessionRef` is: starting a session needs
   * the panes, and setup is read before they exist. */
  const harnessCreatedRef = useRef<(path: string, host: string) => void>(
    () => undefined,
  );
  const onHarnessCreated = useCallback(
    (path: string, host: string) => harnessCreatedRef.current(path, host),
    [],
  );
  const { rescan: rescanHere } = launcher;
  const { rescan: rescanThere } = hostWork;
  /** A rescan of one host's folders, through its own bridge. */
  const rescanOn = useCallback(
    (host: string) =>
      host === LOCAL_HOST_KEY ? rescanHere() : rescanThere(host),
    [rescanHere, rescanThere],
  );
  const setup = useSetup(settings, rescanOn, onHarnessCreated);
  /**
   * Template authoring, held at app level because both of its entry points are:
   * the New Harness dialog and Settings reach the manager, and a harness's page
   * reaches "Save as template".
   */
  const templates = useTemplates();
  const shells = useShells();
  /**
   * The browser pane's views, which live in the main process. The recent-address
   * list is main's to write - it is the side that knows a navigation succeeded -
   * so it arrives on `settings:changed` like any other setting.
   */
  const browsers = useBrowsers(
    settings?.browserRecentUrls ?? DEFAULT_SETTINGS.browserRecentUrls,
  );
  const browserViews = browsers.views;

  /**
   * What the Terminal group shows, and one writer for them. Six of the seven are
   * terminal preferences and reach the terminals through `settings:write`;
   * `projectShellHeightPct` is layout, and sits in that group because it is
   * where somebody looks for the shell.
   */
  const terminalSettings = useMemo(
    () => ({
      terminalFontFamily: settings?.terminalFontFamily ?? null,
      terminalFontSize:
        settings?.terminalFontSize ?? DEFAULT_SETTINGS.terminalFontSize,
      terminalCursorStyle:
        settings?.terminalCursorStyle ?? DEFAULT_SETTINGS.terminalCursorStyle,
      terminalCursorBlink:
        settings?.terminalCursorBlink ?? DEFAULT_SETTINGS.terminalCursorBlink,
      terminalScrollback:
        settings?.terminalScrollback ?? DEFAULT_SETTINGS.terminalScrollback,
      terminalShell: settings?.terminalShell ?? null,
      projectShellHeightPct:
        settings?.projectShellHeightPct ??
        DEFAULT_SETTINGS.projectShellHeightPct,
    }),
    [settings],
  );

  const { writeSettings } = launcher;
  const locateShell = useCallback(() => {
    void helm
      .invoke("path:chooseFile", { title: "Choose a shell" })
      .then(({ path }) => {
        if (path !== null) writeSettings({ terminalShell: path });
      });
  }, [writeSettings]);
  /**
   * A shell's path typed in Settings: the host checks it as it checks the
   * shells it finds, and only a path it kept becomes the setting. Answers the
   * sentence the row shows when it is refused.
   */
  const chooseShellPath = useCallback(
    async (typed: string): Promise<string | null> => {
      try {
        const { shell, problem } = await helm.invoke("pterm:checkShell", {
          path: typed,
        });
        if (shell === null) return problem ?? `${typed} is not a shell.`;
        writeSettings({ terminalShell: shell.path });
        return null;
      } catch (error) {
        return `The shell could not be checked: ${(error as Error).message}`;
      }
    },
    [writeSettings],
  );

  const savedShellHeight =
    settings?.projectShellHeightPct ?? DEFAULT_SETTINGS.projectShellHeightPct;
  const setShellHeight = useCallback(
    (projectShellHeightPct: number) => writeSettings({ projectShellHeightPct }),
    [writeSettings],
  );

  /**
   * The tree's star, both directions. Composed from `settings` rather than from
   * what the tree is holding, so two stars pressed in quick succession cannot
   * each write the other away.
   */
  const togglePin = useCallback(
    (path: string) => {
      const held = settings?.pinnedProjects ?? DEFAULT_SETTINGS.pinnedProjects;
      writeSettings({
        pinnedProjects: withProjectPinned(
          held,
          path,
          !isProjectPinned(held, path),
        ),
      });
    },
    [settings, writeSettings],
  );

  /** The profile being edited, or a seeded draft from "save as profile". Null
   * when the dialog is closed. */
  const [editing, setEditing] = useState<Profile | ProfileDraft | null>(null);
  const [saveProblems, setSaveProblems] = useState<string[]>([]);
  /**
   * A remote project page's Save as profile: a draft for that host's own
   * profile editor in the Profiles sidebar, which keeps it on that host.
   * The nonce makes the same project asked twice a second request.
   */
  const [profileRequest, setProfileRequest] = useState<{
    host: string;
    draft: ProfileDraft;
    nonce: number;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  const projectsByPath = useMemo(() => {
    const map = new Map<string, Project>();
    for (const project of discovery?.projects ?? [])
      map.set(project.path, project);
    return map;
  }, [discovery]);

  // ---------------------------------------------------------------------------
  // The panes
  // ---------------------------------------------------------------------------

  /** Late-bound so the sessions hook can bring a session forward on a
   * notification click, before the layout below exists to do it with. */
  const focusSessionRef = useRef<(id: number) => void>(() => undefined);
  const activateSession = useCallback(
    (id: number) => focusSessionRef.current(id),
    [],
  );
  const sessionState = useSessions(activateSession, hostLink.reconnects);
  const {
    sessions,
    activity: sessionActivity,
    listed: sessionsListed,
  } = sessionState;

  const sessionsById = useMemo(() => {
    const map = new Map<number, SessionRecord>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);

  const savedLayout = settings?.paneLayout ?? null;
  const settingsLoaded = settings !== null;

  /** Another host's session by its id there, as the window last heard it. */
  const remoteSessionOf = useCallback(
    (host: string, id: number): SessionRecord | undefined =>
      hostWork.byHost.get(host)?.sessions.find((session) => session.id === id),
    [hostWork.byHost],
  );
  /** Another host's project by its path there, as its scan found it. */
  const remoteProjectOf = (host: string, path: string): Project | undefined =>
    hostWork.byHost
      .get(host)
      ?.discovery?.projects.find((project) => project.path === path);
  /** A session tab's record and what it is doing, on whichever host it runs. */
  const sessionAt = (ref: {
    id: number;
    host?: string;
  }): { record: SessionRecord; indicator: TabIndicator } | null => {
    const host = ref.host ?? LOCAL_HOST_KEY;
    const record =
      host === LOCAL_HOST_KEY
        ? sessionsById.get(ref.id)
        : remoteSessionOf(host, ref.id);
    if (record === undefined) return null;
    const activity =
      host === LOCAL_HOST_KEY
        ? sessionActivity.get(ref.id)
        : hostWork.byHost.get(host)?.activity.get(ref.id);
    return {
      record,
      indicator: indicatorOf(
        record,
        record.status === "running" ? activity : undefined,
      ),
    };
  };

  /**
   * Whether a tab's thing still exists. A rescan that no longer sees a project
   * closes its tab; a view main has dropped takes its tab; a session main no
   * longer hosts takes its tab.
   */
  const keep = useCallback(
    (ref: PaneRef): boolean => {
      // Another host's folder, session or plugin tab: kept while that host is
      // away, until its own word says its thing is gone (`hostTabs.ts`).
      const remote = keepRemoteTab(ref, {
        settingsLoaded,
        listed: listedHostIds,
        byHost: hostWork.byHost,
        pluginTab: (host, plugin, tab) =>
          (remotePlugins.get(host)?.list ?? null) === null
            ? null
            : pluginsOn(host).get(plugin)?.tabs[tab] !== undefined,
      });
      if (remote !== undefined) return remote;
      if (ref.kind === "project")
        return !discovery || projectsByPath.has(ref.path);
      // The Browser tab is there while it holds a page. Its last page closing
      // closes it, as closing a browser's last tab closes the window.
      if (ref.kind === "browser") return browserViews.size > 0;
      // Until the first list, nothing has said which sessions there are: a
      // saved tab is kept rather than taken for a session that has gone.
      if (ref.kind === "session")
        return !sessionsListed || sessionsById.has(ref.id);
      // Answered, it has nothing left to show.
      if (ref.kind === "restore") return restoreOffer !== null;
      // Kept while the list is still being read, so a restored tab is not
      // dropped before its plugin has had a chance to load.
      if (ref.kind === "plugin") {
        return (
          pluginState.list === null ||
          plugins.get(ref.plugin)?.tabs[ref.tab] !== undefined
        );
      }
      // The same for a plugin's pages tab, kept while any page in it is one
      // the plugin still declares.
      if (ref.kind === "plugin-pages") {
        if (pluginState.list === null) return true;
        const plugin = plugins.get(ref.plugin);
        return (
          plugin !== undefined &&
          ref.pages.some((page) => plugin.tabs[page.tab] !== undefined)
        );
      }
      return true;
    },
    [
      discovery,
      projectsByPath,
      browserViews,
      sessionsById,
      sessionsListed,
      restoreOffer,
      plugins,
      pluginState.list,
      settingsLoaded,
      listedHostIds,
      hostWork.byHost,
      remotePlugins,
      pluginsOn,
    ],
  );

  /**
   * What must have a tab whether or not anything placed it: the Browser tab
   * while main holds a page, since an agent opens pages nothing in this window
   * asked for.
   *
   * Sessions are not among them: they outlive this window and every device
   * sees them, so one has a tab here only where this device put one.
   */
  const hasPages = browserViews.size > 0;
  const extra = useMemo<PaneRef[]>(
    () => (hasPages ? [BROWSER_TAB] : []),
    [hasPages],
  );

  const open = useMemo(
    () => reconcile(layout ?? fromSaved(savedLayout), keep, extra),
    [layout, savedLayout, keep, extra],
  );

  /**
   * One way to change the panes.
   *
   * A functional update, so two changes in one event compose rather than the
   * second overwriting the first, and reconciled against the latest of what
   * exists - read through a ref, because a launch resolves long after the
   * render that started it. The first change of a run is what turns the saved
   * layout into this run's own.
   */
  const latest = useRef({ saved: savedLayout, keep, extra });
  useLayoutEffect(() => {
    latest.current = { saved: savedLayout, keep, extra };
  }, [savedLayout, keep, extra]);
  const commit = useCallback((op: (current: PaneLayout) => PaneLayout) => {
    setLayout((current) => {
      const { saved, keep: exists, extra: unplaced } = latest.current;
      return op(reconcile(current ?? fromSaved(saved), exists, unplaced));
    });
  }, []);

  /**
   * What the window knows of children shown in their parent's tab, while this
   * device shows them (Settings > Agents): the sessions each host lists, and
   * which parent tabs' panes have room (`familyRooms.ts`). A child shown there
   * has no tab and is open here all the same.
   */
  const showChildren =
    settings?.showChildrenInParentTab ??
    DEFAULT_SETTINGS.showChildrenInParentTab;
  const roomOf = useFamilyRoomOf();
  const family = useMemo<FamilyScope | null>(
    () =>
      showChildren
        ? {
            sessions: new Map<string, readonly SessionRecord[]>([
              [LOCAL_HOST_KEY, sessions],
              ...listedHostIds.map(
                (host): [string, readonly SessionRecord[]] => [
                  host,
                  hostWork.byHost.get(host)?.sessions ?? [],
                ],
              ),
            ]),
            roomOf,
          }
        : null,
    [showChildren, sessions, listedHostIds, hostWork.byHost, roomOf],
  );

  /** The children each session tab here holds in its family view, by host and then the parent's row id. */
  const heldFamilies = useMemo(
    () =>
      new Map(
        [...(family?.sessions ?? new Map<string, readonly SessionRecord[]>())].map(
          ([host, there]) => [host, familiesHere(open, there, host)] as const,
        ),
      ),
    [open, family],
  );

  /** The running sessions this device has no tab for and no family view shows. */
  const notOpen = useMemo(
    () =>
      notOpenHere(open, sessions, LOCAL_HOST_KEY, family?.roomOf ?? null),
    [open, sessions, family],
  );
  /**
   * The window's connection carries the terminals of the sessions with a tab
   * here and of the children a parent's tab here shows, and only those: one
   * opened from the sessions pane starts on a new stream that draws its screen
   * as it is.
   */
  // The same for each host on another computer, told again each time the
  // window is connected to it again: a tab whose host dropped kept its last
  // screen, and reattaches here.
  useShownSessionTabs(open, connectedHostIds, hostSessionTabs.show, family);

  const shownMax =
    maximized !== null && groupById(open, maximized) !== undefined
      ? maximized
      : null;
  const shownGroups = useMemo(
    () =>
      shownMax === null ? open.groups.map((group) => group.id) : [shownMax],
    [open.groups, shownMax],
  );
  const sidebarShown = !sidebarHidden && shownMax === null;
  /**
   * The panes sharing the window's width with another: every page in one gets
   * the narrower layout. A pane stacked above or below another still has the
   * whole width, and keeps the wide one.
   */
  const narrow = useMemo(() => {
    if (shownMax !== null) return new Set<number>();
    const rects = paneRects(open);
    return new Set(
      open.groups.flatMap((group) =>
        (rects.get(group.id)?.width ?? 1) < 0.999 ? [group.id] : [],
      ),
    );
  }, [open, shownMax]);
  // Memoized rather than looked up in the body: a group looked up there is, to
  // the React Compiler, something that may be mutated later, which would cost
  // every callback that depends on it its memoization. A hook's result is
  // frozen.
  const focusedGroup = useMemo(() => groupById(open, open.focused), [open]);
  const front = focusedGroup === undefined ? null : activeRef(focusedGroup);
  const frontId = front === null ? null : paneId(front);
  /** The tab in front of each pane on screen. */
  const visible = useMemo(
    () =>
      shownGroups.flatMap((id) => {
        const group = groupById(open, id);
        const ref = group === undefined ? null : activeRef(group);
        return ref === null ? [] : [ref];
      }),
    [open, shownGroups],
  );

  /**
   * The plugins Settings > Plugins lists: the host it shows. A remote host's
   * come through its own bridge while it is connected; while it is not, the
   * page says so rather than listing another host's.
   */
  const shownPluginState =
    pluginsHost === LOCAL_HOST_KEY
      ? pluginState
      : (remotePlugins.get(pluginsHost) ?? {
          list: null,
          error: `${hostName(pluginsHost)} is not connected, so its plugins cannot be read.`,
          live: NO_PLUGINS,
        });
  /** Why a host's plugins cannot be read, or null while they can (or have not answered yet). */
  const pluginsUnreadOn = (host: string): string | null =>
    host === LOCAL_HOST_KEY
      ? pluginState.error
      : connectedHostIds.includes(host)
        ? (remotePlugins.get(host)?.error ?? null)
        : `${hostName(host)} is not connected, so its plugins cannot be read.`;
  /** A plugin's Settings page, with Settings > Plugins showing the plugin's host. */
  const openPluginSettings = (host: string, path: string): void => {
    showHostOn("plugins", host);
    openSettings(pluginSection(path));
  };
  /** The plugin whose Settings page is chosen, and whether that page is on screen to be kept current. */
  const settingsPlugin = settingsSection.startsWith("plugin:")
    ? ((shownPluginState.list ?? []).find(
        (plugin) => pluginSection(plugin.path) === settingsSection,
      ) ?? null)
    : null;
  const settingsOnScreen = visible.some((ref) => ref.kind === "settings");
  const pluginSettings = usePluginSettings(
    settingsOnScreen && settingsPlugin !== null ? settingsPlugin.path : null,
    pluginsHost,
  );
  /** The secrets of the host whose plugin asks for one, whichever host Settings shows. */
  const secretAsk = secretAsks[0] ?? null;
  const askSecrets = usePluginSettings(null, secretAsk?.host ?? LOCAL_HOST_KEY);
  /** Settings > Devices, read only while it is on screen. */
  const devicesSettings = useDevicesSettings(
    DEVICES_DEPS,
    settingsOnScreen && settingsSection === "devices",
    listedHosts,
    remoteView,
  );

  /**
   * Brings a tab forward from outside its pane - the tree, a notification, the
   * status bar - and gives the window back if that tab is in a pane the
   * maximized one is hiding.
   */
  const focusTab = useCallback(
    (id: string) => {
      const at = findTab(open, id);
      if (at === null) return;
      commit((current) => activateTab(current, id));
      setMaximized((current) =>
        current === null || current === at.group ? current : null,
      );
    },
    [open, commit],
  );

  /** Opens a tab in the focused pane, or brings it forward where it already is. */
  const openPane = useCallback(
    (ref: PaneRef) => {
      const at = findTab(open, paneId(ref));
      commit((current) => openTab(current, ref));
      if (at !== null) {
        setMaximized((current) =>
          current === null || current === at.group ? current : null,
        );
      }
    },
    [open, commit],
  );

  /**
   * What the window does with what a plugin page says to it: a key the page
   * did not take is pressed again here, on its frame, so Helm's shortcuts work
   * from inside a plugin as from anywhere else; a tab's title goes on its tab,
   * or on its page in a plugin's strip. Set once - the relay outlives renders,
   * and `commit` is stable.
   */
  useEffect(() => {
    setPluginFrameHooks({
      key: (_spec, element, key) => {
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            ...key,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      title: (spec, title) => {
        if (spec.surface === "tab")
          commit((current) => retitlePluginSurface(current, spec.key, title));
      },
      // The page asked to stay: a page in a strip stops being its preview, a
      // plugin tab the pane's.
      keep: (spec) => {
        if (spec.surface !== "tab") return;
        if (isPluginPageId(spec.key))
          setPagePreviews((current) =>
            withoutPreview(current, spec.plugin, spec.key),
          );
        else setPreview((current) => (current === spec.key ? null : current));
      },
    });
  }, [commit]);

  /**
   * Opens one of a plugin's tabs, or brings it forward: as a page in the
   * plugin's own tab when it declares `pageStrip`, and as a tab of its own in
   * the focused pane when it does not. Either way, the title it was asked for
   * this time is the one it shows, and `asPreview` opens it as the preview the
   * next one replaces - the strip's own, or the pane's that files use.
   *
   * The preview that comes back is worked out from the layout on screen, as
   * `openFileAt` does, because an updater has to be pure.
   */
  const openPluginTab = useCallback(
    (
      plugin: string,
      tab: string,
      params: PluginParams,
      title: string | null,
      asPreview: boolean,
      host: string = LOCAL_HOST_KEY,
    ) => {
      // A remote host's plugin opens each of its tabs as a tab of its own,
      // naming the host; the page strip is this PC's plugins' only.
      if (host === LOCAL_HOST_KEY && plugins.get(plugin)?.pageStrip === true) {
        const page = { tab, params, title };
        const was = pagePreviews.get(plugin) ?? null;
        const at = findTab(open, pluginPagesId(plugin));
        const placed = placePluginPage(open, plugin, page, was, !asPreview);
        commit(
          (current) =>
            placePluginPage(current, plugin, page, was, !asPreview).layout,
        );
        setPagePreviews((current) =>
          withPreview(current, plugin, placed.preview),
        );
        if (at !== null)
          setMaximized((current) =>
            current === null || current === at.group ? current : null,
          );
        return;
      }
      const ref: PaneRef =
        host === LOCAL_HOST_KEY
          ? { kind: "plugin", plugin, tab, params, title }
          : { kind: "plugin", plugin, tab, params, title, host };
      const id = paneId(ref);
      const still =
        preview !== null && findTab(open, preview) !== null ? preview : null;
      const placed = openTabWithPreview(open, ref, still, !asPreview);
      const landed = findTab(placed.layout, id);
      commit((current) => {
        const next = openTabWithPreview(current, ref, still, !asPreview).layout;
        return title === null ? next : retitleTab(next, id, title);
      });
      setPreview(placed.preview);
      setMaximized((current) =>
        current === null || current === landed?.group ? current : null,
      );
    },
    [plugins, pagePreviews, preview, open, commit],
  );

  /**
   * A plugin tab that left the layout ends - closed, or replaced as the
   * preview. Read off the layout, as the pages below are.
   */
  const openPluginTabs = useMemo(
    () =>
      new Set(
        open.groups.flatMap((group) =>
          group.tabs.flatMap((ref) =>
            ref.kind === "plugin" ? [pluginTabKey(ref)] : [],
          ),
        ),
      ),
    [open],
  );
  useEffect(() => {
    disposePluginFrames(
      (spec) =>
        spec.surface === "tab" &&
        !isPluginPageId(spec.key) &&
        !openPluginTabs.has(spec.key),
    );
  }, [openPluginTabs]);

  /**
   * A page that left its plugin's strip ends - closed, closed with its tab,
   * or let go to make room. Read off the layout rather than said at each of
   * those, so no way of leaving can leave a page running with nowhere to be.
   */
  const openPages = useMemo(() => openPluginPageIds(open), [open]);
  useEffect(() => {
    disposePluginFrames(
      (spec) => isPluginPageId(spec.key) && !openPages.has(spec.key),
    );
  }, [openPages]);

  /**
   * A plugin turned off or removed takes its pages with it, and a page from a
   * revision the plugin has moved past ends. One on screen was already
   * reloaded by its slot; this is for the ones parked off it.
   */
  useEffect(() => {
    disposePluginFrames((spec) => {
      const host = spec.host ?? LOCAL_HOST_KEY;
      // Judged only against a list that has been read: a host that is away,
      // or has not answered yet, keeps its frames.
      const listed =
        host === LOCAL_HOST_KEY
          ? pluginState.list
          : (remotePlugins.get(host)?.list ?? null);
      if (listed === null)
        return host !== LOCAL_HOST_KEY && !listedHostIds.includes(host);
      const plugin = pluginsOn(host).get(spec.plugin);
      if (plugin === undefined || spec.revision !== plugin.revision)
        return true;
      if (spec.surface === "tab") return plugin.tabs[spec.name] === undefined;
      if (spec.surface === "panel")
        return plugin.panels[spec.name] === undefined;
      return true;
    });
  }, [pluginsOn, pluginState.list, remotePlugins, listedHostIds]);

  /**
   * The saved panes, written back whenever the arrangement changes.
   *
   * Compared as JSON against what is stored, so the write that comes back as a
   * `settings:changed` broadcast finds nothing to do - an effect keyed on the
   * settings object would re-arm on its own write forever. Debounced because a
   * drag moves a tab at a time and every write is a settings round trip.
   */
  const savedJson = useMemo(() => JSON.stringify(toSaved(open)), [open]);
  const storedJson = useMemo(() => JSON.stringify(savedLayout), [savedLayout]);
  useEffect(() => {
    if (!settingsLoaded || savedJson === storedJson) return undefined;
    const timer = setTimeout(() => {
      writeSettings({ paneLayout: JSON.parse(savedJson) as SavedPaneLayout });
    }, 500);
    return () => clearTimeout(timer);
  }, [settingsLoaded, savedJson, storedJson, writeSettings]);

  /*
   * The process pass runs only while the sessions pane is on screen. One
   * enumeration costs 400ms of a child process, so "off unless somebody is
   * looking" is the whole budget. Reference-counted in main.
   */
  const sessionsPaneOpen = visible.some((ref) => ref.kind === "sessions");
  const watchResources = machineSessions.watch;
  useEffect(() => {
    if (!sessionsPaneOpen) return undefined;
    watchResources(true);
    // Each connected host on another computer runs its own pass while the pane looks.
    remoteHostLinks.watch(true);
    return () => {
      watchResources(false);
      remoteHostLinks.watch(false);
    };
  }, [sessionsPaneOpen, watchResources]);

  /**
   * Which page is on screen, told to every view: the one in front of the
   * Browser tab, while that tab is in front of a pane. A page reports its own
   * rectangle while it is mounted; one that goes behind another page, or a
   * Browser tab that goes behind another tab or into a pane the maximized one
   * hides, has to be stood down by something that is still rendering.
   */
  const { setShowing: setBrowserShowing, active: frontPage } = browsers;
  const browserShown = visible.some((ref) => ref.kind === "browser");
  useEffect(() => {
    for (const id of browserViews.keys())
      setBrowserShowing(id, browserShown && id === frontPage);
  }, [browserViews, browserShown, frontPage, setBrowserShowing]);

  // Main decides whether an exiting session is worth a notification, and that
  // turns on which sessions are actually on screen - which only this side knows.
  const { reportFocus } = sessionState;
  const visibleSessionKey = visible
    .flatMap((ref) => (isSessionOn(ref, LOCAL_HOST_KEY) ? [ref.id] : []))
    .join(",");
  useEffect(() => {
    reportFocus(
      visibleSessionKey === "" ? [] : visibleSessionKey.split(",").map(Number),
    );
  }, [visibleSessionKey, reportFocus]);

  /**
   * The project the focused pane is about, for a browser tab opened beside it.
   *
   * Derived from `open` inside a memo rather than from `front` in the render
   * body: `front` is an object handed on to helpers further down, and the
   * React Compiler treats anything derived from it as possibly mutated, which
   * costs `openBrowser` its memoization.
   */
  const frontProject = useMemo(() => {
    const group = groupById(open, open.focused);
    const ref = group === undefined ? null : activeRef(group);
    if (ref?.kind === "project" || ref?.kind === "terminal") return ref.path;
    if (ref?.kind === "file") return ref.root;
    if (ref?.kind === "session" && hostOf(ref) !== LOCAL_HOST_KEY) return null;
    if (ref?.kind === "session")
      return sessionsById.get(ref.id)?.projectPath ?? null;
    return null;
  }, [open, sessionsById]);

  // ---------------------------------------------------------------------------
  // Opening things
  // ---------------------------------------------------------------------------

  const openProject = useCallback(
    (project: Project | null) => {
      if (project) openPane({ kind: "project", path: project.path });
    },
    [openPane],
  );
  const openSessions = useCallback(
    () => openPane({ kind: "sessions" }),
    [openPane],
  );
  const openHistory = useCallback(
    () => openPane({ kind: "history" }),
    [openPane],
  );
  const openConfig = useCallback(
    () => openPane({ kind: "config" }),
    [openPane],
  );
  /**
   * Settings is a tab like any other rather than a modal: it is a place, worth
   * leaving open beside a session, and a dialog over the window would be one
   * more thing to dismiss before looking at what a setting changed. Its
   * sections are a sidebar view, which opens with it.
   */
  const openSettings = useCallback(
    (section?: SettingsSectionId) => {
      if (section !== undefined) setSettingsSection(section);
      setSidebarView("settings");
      setSidebarHidden(false);
      openPane({ kind: "settings" });
    },
    [openPane],
  );

  /**
   * Config opened **on** a project - the project page's link. The pane arrives
   * pointed at the project that was on screen instead of at whatever it last
   * held; re-pointing goes through the hook's own setter, because that is what
   * clears the open file. Skipped when the scope is already the one asked for,
   * so returning to a pane keeps what is open in it.
   */
  const { scopePath: configScopePath, setScopePath: setConfigScope } =
    configState;
  const openConfigAt = useCallback(
    (project: Project, host: string = LOCAL_HOST_KEY) => {
      if (configHost !== host) {
        // Config switches to the project's host, and the scope is pointed
        // once the switch has cleared what it showed.
        showHostOn("config", host);
        setPendingScope({ surface: "config", path: project.path, host });
      } else if (configScopePath.toLowerCase() !== project.path.toLowerCase()) {
        setConfigScope(project.path);
      }
      openPane({ kind: "config" });
    },
    [configHost, showHostOn, configScopePath, setConfigScope, openPane],
  );
  /**
   * Where the caret should go in the Browser tab - a page's address bar (Ctrl+L,
   * a new page) or its find field (Ctrl+F) - until that page's pane has put it
   * there and said so (`onFocusRequestDone`). Answered once, so a page coming
   * back to the front later does not take the caret again.
   */
  const [browserFocus, setBrowserFocus] = useState<{
    page: number;
    what: "address" | "find";
  } | null>(null);
  const browserFocusDone = useCallback(() => setBrowserFocus(null), []);

  /**
   * A new page in the Browser tab, on whichever project the focused pane is
   * about, so it arrives on that project's last address rather than empty.
   * Main decides that from `browserProjectUrls`; nothing here reads it.
   *
   * A `project` of null asks for an empty page on purpose - the `+`'s - and
   * `into` puts the Browser tab in that pane rather than the focused one.
   * `focusAddress` gives the address bar the caret once the page is up, which
   * is what a new empty page is for.
   */
  const openBrowser = useCallback(
    (
      request: {
        url?: string;
        project?: string | null;
        into?: number;
        focusAddress?: boolean;
      } = {},
    ) => {
      const { url, project, into, focusAddress } = request;
      void browsers
        .open({
          ...(url === undefined ? {} : { url }),
          project: project === undefined ? frontProject : project,
        })
        .then((state) => {
          if (state === null) return;
          commit((current) =>
            into === undefined
              ? openTab(current, BROWSER_TAB)
              : placeIn(current, BROWSER_TAB, into),
          );
          if (focusAddress === true)
            setBrowserFocus({ page: state.id, what: "address" });
        });
    },
    [browsers, commit, frontProject],
  );

  /**
   * The rail's Browser: go to the Browser tab, opening a page only if it holds
   * none. A destination that made a new page on every press would pile pages
   * up to the cap; Ctrl+T and the strip's `+` are how another is asked for.
   */
  const showBrowser = useCallback(() => {
    if (findTab(open, paneId(BROWSER_TAB)) === null) openBrowser();
    else focusTab(paneId(BROWSER_TAB));
  }, [open, openBrowser, focusTab]);

  /**
   * A link in rendered content. A loopback URL is by definition a thing running
   * on this machine, which is what the browser pane exists to look at; anything
   * else goes to the browser the user actually uses. `isLoopbackUrl` is the
   * function the certificate exception and the reach rule are made of, so
   * "what counts as this machine" has one answer.
   */
  const openLink = useCallback(
    (url: string) => {
      if (isLoopbackUrl(url)) openBrowser({ url });
      else void helmOpenExternal(url);
    },
    [openBrowser],
  );

  /**
   * Open in browser on a port of a session on another computer: main forwards
   * it to this PC's loopback, and the Browser tab opens that address.
   */
  const { forwards, portProblems, openRemotePort } =
    useForwardedPorts(openBrowser);

  /**
   * What a plugin asked main for that needs the window: a tab of its own
   * opened, a secret it is missing typed in, a session started or a link
   * opened. Main has checked that the tab and the key are ones the plugin
   * declares, and that a link is an `https` address.
   */
  useEffect(() => {
    // Heard from every host: a remote host's plugin asks over that host's
    // connection, and is answered there.
    const offs: Array<() => void> = [];
    const stop = eachHostBridge((host, bridge) => {
      offs.push(
        bridge.on("plugins:ui", (request) => {
          if (request.kind === "secret") {
            setSecretAsks((current) => [...current, { ...request, host }]);
            return;
          }
          if (request.kind === "session") {
            setSessionAsks((current) => [...current, { ...request, host }]);
            return;
          }
          if (request.kind === "sessionWithdrawn") {
            setSessionAsks((current) =>
              current.filter(
                (ask) =>
                  ask.host !== host || ask.requestId !== request.requestId,
              ),
            );
            return;
          }
          if (request.kind === "link") {
            // A project of null: a plugin's link is not the address a project's
            // Browser tab should come back to.
            openBrowser({ url: request.url, project: null });
            return;
          }
          openPluginTab(
            request.plugin,
            request.tab,
            request.params,
            request.title,
            request.preview,
            host,
          );
        }),
      );
    });
    return () => {
      stop();
      for (const off of offs) off();
    };
  }, [openPluginTab, openBrowser]);

  /**
   * A launched session lands in the focused pane and takes its front - or, from
   * the launcher's "Start beside", in the pane beside it (`besideOf`), opening
   * one if the focused pane is alone - or, from a pane's `+`, in that pane
   * (`into`).
   */
  const placeSession = useCallback(
    (
      id: number,
      beside = false,
      into?: number,
      host: string = LOCAL_HOST_KEY,
    ) => {
      const ref = sessionRef(id, host);
      commit((current) =>
        into !== undefined
          ? placeIn(current, ref, into)
          : beside
            ? placeBeside(current, ref)
            : openTab(current, ref),
      );
      const landing = into ?? open.focused;
      setMaximized((current) =>
        (into === undefined && beside) ||
        (current !== null && current !== landing)
          ? null
          : current,
      );
    },
    [commit, open.focused],
  );

  /**
   * Brings a session's tab forward, or - for a session running in the host
   * that this device has no tab for - opens one in the focused pane, whose
   * screen comes on a new stream from the host.
   */
  const openSession = useCallback(
    (id: number) => {
      if (findTab(open, `session:${String(id)}`) !== null)
        focusTab(`session:${String(id)}`);
      else if (sessionsById.has(id)) placeSession(id);
    },
    [open, focusTab, sessionsById, placeSession],
  );
  useEffect(() => {
    focusSessionRef.current = openSession;
  }, [openSession]);

  /** The same for a session on a host on another computer: its tab forward, or a tab here for it. */
  const openRemoteSession = useCallback(
    (host: string, id: number) => {
      const tab = paneId(sessionRef(id, host));
      if (findTab(open, tab) !== null) focusTab(tab);
      else placeSession(id, false, undefined, host);
    },
    [open, focusTab, placeSession],
  );

  /**
   * A terminal tab in `path`: a plain shell, no `claude`. It lands where a
   * launched session would - the focused pane, the pane beside it, or `into`.
   * The id is this window's; the shell is opened when the tab first draws.
   */
  const nextTerminalId = useRef(1);
  const openTerminal = useCallback(
    (
      path: string,
      beside = false,
      into?: number,
      host: string = LOCAL_HOST_KEY,
    ) => {
      const id = nextTerminalId.current++;
      const ref: PaneRef =
        host === LOCAL_HOST_KEY
          ? { kind: "terminal", id, path }
          : { kind: "terminal", id, path, host };
      commit((current) =>
        into !== undefined
          ? placeIn(current, ref, into)
          : beside
            ? placeBeside(current, ref)
            : openTab(current, ref),
      );
      const landing = into ?? open.focused;
      setMaximized((current) =>
        (into === undefined && beside) ||
        (current !== null && current !== landing)
          ? null
          : current,
      );
    },
    [commit, open.focused],
  );

  /** The project on this PC whose launch from the tree or its page was the last, for the line over the panes. */
  const [localLaunch, setLocalLaunch] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const launch = useCallback(
    async (project: Project) => {
      setLocalLaunch({ path: project.path, name: project.name });
      setLaunchingPath(project.path);
      try {
        const id = await sessionState.launch(
          project,
          bodyRefs.current.get(open.focused) ?? null,
        );
        if (id !== null) placeSession(id);
      } finally {
        setLaunchingPath(null);
      }
    },
    [sessionState, placeSession, open.focused],
  );

  /**
   * A project's `+` or Start on a host on another computer: started there
   * through its own bridge, and given a tab here like any launch.
   */
  const [remoteLaunchError, setRemoteLaunchError] =
    useState<TreeLaunchFailure | null>(null);
  const { adopt: adoptThere, forget: forgetThere } = hostWork;
  const launchOn = useCallback(
    async (host: string, project: Project) => {
      if (host === LOCAL_HOST_KEY) {
        await launch(project);
        return;
      }
      setLaunchingPath(project.path);
      setRemoteLaunchError(null);
      try {
        const { cols, rows } = estimateGrid(
          bodyRefs.current.get(open.focused) ?? null,
        );
        const record = await bridgeFor(host).invoke("session:start", {
          cwd: project.path,
          projectPath: project.path,
          name: project.name,
          cols,
          rows,
        });
        adoptThere(host, record);
        placeSession(record.id, false, undefined, host);
      } catch (err: unknown) {
        setRemoteLaunchError({
          host,
          path: project.path,
          name: project.name,
          text: readable(err),
        });
      } finally {
        setLaunchingPath(null);
      }
    },
    [launch, adoptThere, placeSession, open.focused],
  );

  /**
   * The user's answer to the front session request. Main launches what it
   * holds for the request; the window sends only the answer and the grid of
   * the pane the session lands in, and places what comes back like any launch.
   */
  const frontSessionAsk = sessionAsks[0] ?? null;
  const answerSessionAsk = useCallback(
    async (start: boolean) => {
      if (frontSessionAsk === null) return;
      const { requestId } = frontSessionAsk;
      const next = (): void => {
        setSessionAsks((current) =>
          current.filter((ask) => ask.requestId !== requestId),
        );
        setSessionAskState({ busy: false, error: null });
      };
      // A failed launch has spent the request; closing is all that is left.
      if (!start || sessionAskState.error !== null) {
        if (sessionAskState.error === null) {
          void bridgeFor(frontSessionAsk.host)
            .invoke("plugins:session", {
              requestId,
              start: false,
              cols: 0,
              rows: 0,
            })
            .catch(() => undefined);
        }
        next();
        return;
      }
      setSessionAskState({ busy: true, error: null });
      try {
        const { cols, rows } = estimateGrid(
          bodyRefs.current.get(open.focused) ?? null,
        );
        const on = frontSessionAsk.host;
        const record = await bridgeFor(on).invoke("plugins:session", {
          requestId,
          start: true,
          cols,
          rows,
        });
        if (record !== null) {
          if (on === LOCAL_HOST_KEY) sessionState.adopt(record);
          else adoptThere(on, record);
          placeSession(record.id, false, undefined, on);
        }
        next();
      } catch (err: unknown) {
        setSessionAskState({ busy: false, error: readable(err) });
      }
    },
    [
      frontSessionAsk,
      sessionAskState.error,
      sessionState,
      adoptThere,
      placeSession,
      open.focused,
    ],
  );

  /** A profile launch lands exactly the way a project launch does - or in the pane `into`. */
  const launchProfile = useCallback(
    async (profile: Profile, into?: number) => {
      const session = await profileState.launch(
        profile,
        bodyRefs.current.get(into ?? open.focused) ?? null,
      );
      if (!session) return;
      sessionState.adopt(session);
      placeSession(session.id, false, into);
    },
    [profileState, sessionState, placeSession, open.focused],
  );

  /** A profile from the `+` popover, on the host it was opened on: that host's own profile, started there. */
  const { launch: launchHostProfile } = launcherProfiles;
  const launchProfileOn = useCallback(
    async (host: string, profile: Profile, into?: number) => {
      if (host === LOCAL_HOST_KEY) {
        await launchProfile(profile, into);
        return;
      }
      const record = await launchHostProfile(
        profile,
        bodyRefs.current.get(into ?? open.focused) ?? null,
      );
      if (record === null) return;
      adoptThere(host, record);
      placeSession(record.id, false, into, host);
    },
    [launchProfile, launchHostProfile, adoptThere, placeSession, open.focused],
  );

  /**
   * A resumed conversation is a session like any other once it exists; main
   * decided upstream whether it could be reopened and built `--resume` argv.
   */
  const resumeSession = useCallback(
    async (session: HistorySession) => {
      // On the host whose history it is, in a tab naming that host.
      const on = historyHost;
      const record = await historyState.resume(
        session,
        bodyRefs.current.get(open.focused) ?? null,
      );
      if (!record) return;
      if (on === LOCAL_HOST_KEY) sessionState.adopt(record);
      else adoptThere(on, record);
      placeSession(record.id, false, undefined, on);
    },
    [
      historyHost,
      historyState,
      sessionState,
      adoptThere,
      placeSession,
      open.focused,
    ],
  );

  /**
   * What a launcher was showing when Start was pressed: Ctrl+N's, or - with
   * `into` - the popover from a pane's `+`, whose session lands in that pane.
   * The grid is measured off the pane the session is going to, where that pane
   * exists; a new one beside is measured off the focused pane and refits when
   * it lands.
   */
  const startChosen = useCallback(
    async (choice: LaunchChoice, into?: number) => {
      const on = newSession.host;
      const target =
        into ??
        (choice.beside
          ? (besideOf(open, open.focused) ?? open.focused)
          : open.focused);
      const launched = await newSession.launch(
        {
          cwd: choice.project.path,
          projectPath: choice.project.path,
          name: choice.project.name,
          profileId: choice.profileId,
          permissionMode: choice.permissionMode,
          resume: choice.resume?.sessionId ?? null,
        },
        bodyRefs.current.get(target) ?? null,
      );
      if (launched === null) return;
      if (on === LOCAL_HOST_KEY) sessionState.adopt(launched.session);
      else adoptThere(on, launched.session);
      placeSession(launched.session.id, choice.beside, into, on);
      if (into === undefined) newSession.hide();
      else setNewTab(null);
    },
    [newSession, sessionState, adoptThere, placeSession, open],
  );

  /*
   * A harness created whole ends in a session in it, not on a page: creating
   * one is a step on the way to working there. Not during first run, which
   * owns the window until it is finished.
   */
  const setupNeeded = setup.needed;
  useEffect(() => {
    harnessCreatedRef.current = (path: string, host: string) => {
      if (setupNeeded) return;
      void newSession
        .launch(
          {
            cwd: path,
            projectPath: path,
            profileId: null,
            permissionMode: null,
            resume: null,
          },
          bodyRefs.current.get(open.focused) ?? null,
          host,
        )
        .then((launched) => {
          if (launched === null) return;
          if (host === LOCAL_HOST_KEY) sessionState.adopt(launched.session);
          else adoptThere(host, launched.session);
          placeSession(launched.session.id, false, undefined, host);
        });
    };
  }, [
    setupNeeded,
    newSession,
    sessionState,
    adoptThere,
    placeSession,
    open.focused,
  ]);

  /** The sessions a lost tab's Restore asked for, ticked when the Restore sessions tab opens. */
  const [restoreChosen, setRestoreChosen] = useState<readonly number[] | null>(
    null,
  );

  /**
   * Reopens sessions a crash took and puts each back in the pane and place it
   * had, sized for that pane. Unasked is the `restoreWithoutAsking` path, which
   * also says afterwards that it happened.
   */
  const resumeLost = useCallback(
    async (ids: readonly number[], unasked = false) => {
      if (restoreOffer === null) return;
      const { layout } = restoreOffer;
      // Sized for the pane at the saved one's place in reading order, when
      // there is one there now; the panes are rearranged around them after.
      const paneOf = (id: number): number =>
        savedGroups(layout).findIndex((group) =>
          group.panes.some((pane) => pane.kind === "session" && pane.id === id),
        );
      const picks = ids.map((id) => {
        const there = open.groups[paneOf(id)];
        const body =
          (there === undefined ? undefined : bodyRefs.current.get(there.id)) ??
          bodyRefs.current.get(open.focused);
        return { id, ...estimateGrid(body ?? null) };
      });
      const result = await restoreLost(picks, {
        unasked,
        lostWith: LOCAL_HOST_NAME,
      });
      if (result === null) return;
      for (const { launched } of result.restored)
        sessionState.adopt(launched.session);
      const pairs = new Map(
        result.restored.map(({ from, launched }) => [
          from,
          launched.session.id,
        ]),
      );
      setRestoreChosen(null);
      commit((current) => {
        // A session lost with its host while its tab was open comes back in
        // that tab; one lost with Helm goes back where the saved layout had
        // it; one neither names still opens here: it was asked for.
        const inPlace = replaceSessionTabs(closeTab(current, "restore"), pairs);
        const elsewhere = new Map(
          [...pairs].filter(
            ([from]) => findTab(current, `session:${String(from)}`) === null,
          ),
        );
        let placed = placeRestored(inPlace, layout, elsewhere);
        for (const id of pairs.values()) {
          if (findTab(placed, `session:${String(id)}`) === null)
            placed = openTab(placed, { kind: "session", id });
        }
        return placed;
      });
    },
    [restoreOffer, restoreLost, sessionState, commit, open],
  );

  /*
   * The offer, acted on once settings say how: a tab in front of the focused
   * pane, or - with `restoreWithoutAsking` - every session reopened straight
   * away and the offer never drawn. Those that cannot come back are asked for
   * too, so main says why in the same answer.
   */
  const restoreUnasked =
    settings === null ? null : settings.restoreWithoutAsking;
  const actedOn = useRef<RestoreOffer | null>(null);

  /**
   * A lost tab's Restore: the Restore sessions tab, with only that session
   * ticked, through the one restore path there is.
   */
  const restoreSession = useCallback(
    (id: number) => {
      setRestoreChosen([id]);
      commit((current) => openTab(current, { kind: "restore" }));
    },
    [commit],
  );
  useEffect(() => {
    if (
      restoreOffer === null ||
      restoreUnasked === null ||
      actedOn.current === restoreOffer
    )
      return;
    actedOn.current = restoreOffer;
    if (restoreUnasked)
      void resumeLost(
        restoreOffer.sessions.map((session) => session.id),
        true,
      );
    else commit((current) => openTab(current, { kind: "restore" }));
  }, [restoreOffer, restoreUnasked, resumeLost, commit]);

  const blankProfile = useCallback(
    (root: string, name: string): ProfileDraft => ({
      name,
      root,
      overlays: [],
      access: [],
      model: null,
      effort: null,
      permissionMode: null,
      agent: null,
      mcp: [],
      openingPrompt: null,
      pinnedOrder: null,
    }),
    [],
  );

  const saveAsProfileOn = useCallback(
    (host: string, project: Project) => {
      setProfileRequest((last) => ({
        host,
        // Seeded as this PC's page seeds it: the project as the root, itself composed.
        draft: {
          ...blankProfile(project.path, project.name),
          overlays: [project.path],
          access: [project.path],
        },
        nonce: (last?.nonce ?? 0) + 1,
      }));
      setSidebarHidden(false);
      setSidebarView("profiles");
    },
    [blankProfile],
  );

  /**
   * What the profile editor's agent and MCP pickers offer: the same
   * `config:effective` the config console calls, asked about the composition
   * being *typed* rather than a saved one.
   */
  const predictProfile = useCallback(
    async (root: string, overlays: string[]): Promise<ProfilePrediction> => {
      const view = await helm.invoke("config:effective", {
        cwd: root,
        overlays,
      });
      return { agents: view.agents, mcpServers: view.mcpServers };
    },
    [],
  );

  const saveProfile = useCallback(
    async (draft: ProfileDraft) => {
      setSaving(true);
      try {
        const id = editing !== null && "id" in editing ? editing.id : null;
        const { profile, problems } = await profileState.save(draft, id);
        setSaveProblems(problems);
        if (profile === null) return;
        setEditing(null);
        // A new profile is made to be used: it ends in a session, not on the
        // list it was added to. An edit is only an edit.
        if (id === null) void launchProfile(profile);
      } finally {
        setSaving(false);
      }
    },
    [editing, profileState, launchProfile],
  );

  // Main asks the user first, so this can be fired and forgotten.
  const deleteProfile = useCallback(
    (profile: Profile) => void profileState.remove(profile.id),
    [profileState],
  );

  // ---------------------------------------------------------------------------
  // Closing and moving
  // ---------------------------------------------------------------------------

  /**
   * A session's tab. The process gets a say: main confirms before ending a live
   * session, and the tab stays if the answer is no.
   */
  const closeSession = useCallback(
    (id: number) => {
      void sessionState.close(id).then((closed) => {
        if (closed)
          commit((current) => closeTab(current, `session:${String(id)}`));
      });
    },
    [sessionState, commit],
  );

  /**
   * Close tab, keep running: the tab goes and the session runs on, listed in the sessions pane as not open here. Nothing
   * is asked, because nothing ends.
   */
  /**
   * A session's tab on a host on another computer. That host asks first,
   * naming itself, through the window's confirmation; the tab stays if the
   * answer is no.
   */
  const closeRemoteSession = useCallback(
    (host: string, id: number) => {
      void bridgeFor(host)
        .invoke("session:close", { id })
        .then(({ closed }) => {
          if (!closed) return;
          disposeTerminal(id, host);
          forgetThere(host, id);
          commit((current) => closeTab(current, paneId(sessionRef(id, host))));
        });
    },
    [forgetThere, commit],
  );

  const keepRunning = useCallback(
    (id: number, host: string = LOCAL_HOST_KEY) =>
      closeKeepingRunning(
        id,
        host,
        {
          release: hostSessionTabs.release,
          disposeTerminal,
          commit,
        },
        // A child its parent's tab shows next stays on its stream.
        returnsToFamily(
          open,
          family?.sessions.get(host) ?? [],
          id,
          host,
          family?.roomOf ?? null,
        ),
      ),
    [commit, open, family],
  );
  /** The session a tab id names, on whichever host, or null for any other tab. */
  const sessionTabRef = useCallback(
    (tab: string): { id: number; host: string } | null => {
      const at = findTab(open, tab);
      const ref =
        at === null ? undefined : groupById(open, at.group)?.tabs[at.index];
      return ref?.kind === "session" ? { id: ref.id, host: hostOf(ref) } : null;
    },
    [open],
  );
  /** A tab's menu: a running session's offers Close tab, keep running. */
  const tabMenuFor = useCallback(
    (tab: string): MenuEntry[] => {
      const ref = sessionTabRef(tab);
      if (ref === null) return [];
      const record =
        ref.host === LOCAL_HOST_KEY
          ? sessionsById.get(ref.id)
          : remoteSessionOf(ref.host, ref.id);
      return record?.status === "running"
        ? [{ kind: "item", id: KEEP_RUNNING, label: "Close tab, keep running" }]
        : [];
    },
    [sessionTabRef, sessionsById, remoteSessionOf],
  );
  const onTabMenu = useCallback(
    (tab: string, item: string) => {
      const ref = sessionTabRef(tab);
      if (item === KEEP_RUNNING && ref !== null) keepRunning(ref.id, ref.host);
    },
    [keepRunning, sessionTabRef],
  );

  const closeAny = useCallback(
    (id: string) => {
      const at = findTab(open, id);
      const ref =
        at === null ? undefined : groupById(open, at.group)?.tabs[at.index];
      if (ref === undefined) return;
      if (ref.kind === "session") {
        if (hostOf(ref) === LOCAL_HOST_KEY) closeSession(ref.id);
        else closeRemoteSession(hostOf(ref), ref.id);
        return;
      }
      // The shell dies with its tab, not with a render: hiding the page keeps
      // it, closing the project ends it.
      if (ref.kind === "project") void disposeShell(ref.path, hostOf(ref));
      if (ref.kind === "terminal")
        void disposeShell(terminalShellKey(ref.id), hostOf(ref));
      // Hiding the pane keeps the pages; closing the tab destroys them all.
      if (ref.kind === "browser") browsers.closeAll();
      // Closing the offer is "not now", the same as its button.
      if (ref.kind === "restore") dismissRestore();
      commit((current) => closeTab(current, id));
    },
    [open, closeSession, closeRemoteSession, browsers, commit, dismissRestore],
  );

  const splitFocused = useCallback(() => {
    commit(sendBeside);
    setMaximized(null);
  }, [commit]);

  /**
   * A tab dropped on a pane: in its middle, it joins that pane at the end of
   * the strip; at a side, it opens a new pane there. A new pane would be
   * hidden behind a maximized one, so the window is given back first.
   */
  const dropTab = useCallback(
    (tab: string, group: number, zone: PaneDropZone) => {
      if (zone === "center") {
        commit((current) =>
          moveTab(
            current,
            tab,
            group,
            groupById(current, group)?.tabs.length ?? 0,
          ),
        );
        return;
      }
      commit((current) => splitWith(current, tab, group, zone));
      setMaximized(null);
    },
    [commit],
  );

  /**
   * Which zones of a pane would do anything with the tab being dragged: not
   * its own pane's middle, which is where it already is, and not a side of a
   * pane whose only tab it is, which would put a new pane where that one
   * stood. `splitWith` refuses the second anyway; saying so here is what keeps
   * a preview from promising it.
   */
  const dropAllows = useCallback(
    (group: PaneGroupState, zone: PaneDropZone): boolean => {
      if (draggingTab === null) return false;
      const own = group.tabs.some((ref) => paneId(ref) === draggingTab);
      if (zone === "center") return !own;
      return !own || group.tabs.length > 1;
    },
    [draggingTab],
  );

  /** A tab drag starting or ending in any strip. */
  const { setSuppressed: suppressBrowsers } = browsers;
  const onTabDragging = useCallback(
    (tab: string | null) => {
      setDraggingTab(tab);
      // A native view paints over the drop marks, the zones' preview and the
      // dragged tab's ghost, so it stands down for the length of the gesture.
      suppressBrowsers("tab-drag", tab !== null);
    },
    [suppressBrowsers],
  );

  /**
   * A pane divider held or let go. A native view takes the mouse at the OS
   * level, before any pointer capture in this window, so a divider dragged
   * toward a page stopped where the pointer reached it. The views stand down
   * for the gesture and the pointer stays with the window.
   */
  const onPaneResizing = useCallback(
    (resizing: boolean) => suppressBrowsers("pane-resize", resizing),
    [suppressBrowsers],
  );

  // ---------------------------------------------------------------------------
  // The keyboard
  // ---------------------------------------------------------------------------

  /**
   * What a browser key does, from wherever it was pressed: here with the caret
   * in the Browser tab's chrome, or in a page, where main reads it and sends
   * `browser:command`. One place, so the two cannot differ. `id` is the page
   * the key was meant for - the one in front, or the page it was pressed in.
   */
  const runBrowserCommand = useCallback(
    (id: number | null, command: BrowserCommand) => {
      if (command === "new-page") {
        openBrowser({ project: null, focusAddress: true });
        return;
      }
      if (command === "reopen-page") {
        void browsers.reopen().then((state) => {
          if (state !== null)
            commit((current) => openTab(current, BROWSER_TAB));
        });
        return;
      }
      const page = id === null ? undefined : browserViews.get(id);
      if (page === undefined) return;
      if (page.id !== frontPage) browsers.activate(page.id);
      switch (command) {
        case "close-page":
          browsers.close(page.id);
          return;
        case "find":
        case "address":
          setBrowserFocus({ page: page.id, what: command });
          return;
        case "reload":
        case "hard-reload":
          browsers.reload(page.id, command === "hard-reload");
          return;
        case "back":
          browsers.back(page.id);
          return;
        case "forward":
          browsers.forward(page.id);
          return;
        case "zoom-in":
          browsers.zoom(
            page.id,
            Math.min(BROWSER_ZOOM.max, page.zoomLevel + BROWSER_ZOOM.step),
          );
          return;
        case "zoom-out":
          browsers.zoom(
            page.id,
            Math.max(BROWSER_ZOOM.min, page.zoomLevel - BROWSER_ZOOM.step),
          );
          return;
        case "zoom-reset":
          browsers.zoom(page.id, 0);
          return;
        case "devtools":
          browsers.devtools(page.id);
      }
    },
    [openBrowser, browsers, browserViews, frontPage, commit],
  );
  useEffect(
    () =>
      helm.on("browser:command", ({ id, command }) =>
        runBrowserCommand(id, command),
      ),
    [runBrowserCommand],
  );

  /**
   * The browser's keys with the caret in Helm's own chrome, only while the
   * Browser tab is in front of the focused pane (`shared/browserKeys.ts` has
   * the list). In capture so a focused terminal does not eat them - but gated,
   * because Ctrl+L is *clear the screen* in every shell Helm hosts and
   * stealing it from a session would be a worse bug than not having the
   * shortcut. A menu or a dialog open has the keys to itself.
   */
  const browserInFront = front?.kind === "browser";
  useEffect(() => {
    if (!browserInFront) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = browserKeyCommand(
        {
          key: event.key,
          code: event.code,
          control: event.ctrlKey,
          shift: event.shiftKey,
          alt: event.altKey,
          meta: event.metaKey,
        },
        hostOs(),
      );
      if (command === null || overlayOpen()) return;
      if (document.activeElement?.closest(".xterm")) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat && !COMMANDS_THAT_REPEAT.has(command)) return;
      runBrowserCommand(frontPage, command);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [browserInFront, frontPage, runBrowserCommand]);

  /**
   * Ctrl+W and Ctrl+F4 close the page in front of a plugin's strip, as they
   * close the Browser tab's - while that plugin's tab is in front of the
   * focused pane, with the caret in Helm's chrome or in the page, which
   * forwards a key it did not take. Gated as the browser's keys are, and never
   * taken from a terminal.
   */
  const frontPages: PluginPagesRef | null =
    front?.kind === "plugin-pages" ? front : null;
  const frontPagesPlugin = frontPages?.plugin ?? null;
  const frontStripPage =
    frontPages === null ? null : frontPluginPage(frontPages);
  const frontStripPageId =
    frontPagesPlugin === null || frontStripPage === null
      ? null
      : pluginPageId(frontPagesPlugin, frontStripPage);
  useEffect(() => {
    if (frontPagesPlugin === null || frontStripPageId === null)
      return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!hasPrimaryModifier(event) || event.shiftKey || event.altKey) return;
      // Ctrl+F4 is Windows' second close chord; a Mac has only Cmd+W.
      if (event.key.toLowerCase() !== "w" && (event.key !== "F4" || isMac()))
        return;
      if (overlayOpen() || document.activeElement?.closest(".xterm")) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      commit((current) =>
        closePluginPage(current, frontPagesPlugin, frontStripPageId),
      );
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [frontPagesPlugin, frontStripPageId, commit]);

  /** The folder the focused pane is about, for the launcher to open on. */
  const frontFolder = useMemo(() => {
    const group = groupById(open, open.focused);
    return folderOf(
      group === undefined ? null : activeRef(group),
      sessionsById,
      remoteSessionOf,
    );
  }, [open, sessionsById, remoteSessionOf]);
  /** The host of the tab in front, while the window is connected to it; this PC otherwise. */
  const frontHost = useMemo(() => {
    const group = groupById(open, open.focused);
    const ref = group === undefined ? null : activeRef(group);
    const host = ref === null ? LOCAL_HOST_KEY : hostOf(ref);
    return host !== LOCAL_HOST_KEY && connectedHostIds.includes(host)
      ? host
      : LOCAL_HOST_KEY;
  }, [open, connectedHostIds]);
  const { show: showLauncher } = newSession;
  const openLauncher = useCallback(
    () =>
      showLauncher(
        frontHost === LOCAL_HOST_KEY ? frontFolder : null,
        frontHost,
      ),
    [showLauncher, frontFolder, frontHost],
  );

  /**
   * A pane's `+`: opens what it offers, hanging from it, or closes it when it
   * is already open. What it opens reads the session index afresh, as Ctrl+N
   * does.
   */
  const { prepare: prepareLauncher, dismissError: dismissLaunchError } =
    newSession;
  const toggleNewTab = useCallback(
    (group: number, anchor: HTMLElement) => {
      if (newTab?.group === group) {
        setNewTab(null);
        return;
      }
      const pane = groupById(open, group);
      const front = pane === undefined ? null : activeRef(pane);
      // The host of what the pane shows, as Ctrl+N takes the front tab's.
      const on =
        front !== null && connectedHostIds.includes(hostOf(front))
          ? hostOf(front)
          : LOCAL_HOST_KEY;
      prepareLauncher(on);
      setNewTab({
        group,
        anchor,
        folder: folderOf(front, sessionsById, remoteSessionOf),
        host: on,
      });
    },
    [
      newTab,
      open,
      sessionsById,
      remoteSessionOf,
      connectedHostIds,
      prepareLauncher,
    ],
  );
  const closeNewTab = useCallback(() => {
    setNewTab(null);
    dismissLaunchError();
  }, [dismissLaunchError]);

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  /** The file tabs on screen: the ones read, re-read and watched. */
  const shownFiles = useMemo(
    () =>
      visible.flatMap((ref) =>
        ref.kind !== "file"
          ? []
          : hostOf(ref) === LOCAL_HOST_KEY
            ? [{ root: ref.root, path: ref.path }]
            : [{ root: ref.root, path: ref.path, host: hostOf(ref) }],
      ),
    [visible],
  );
  /** The host of the tab in front, connected or not: the Files view follows its folder only on the host it shows. */
  const frontRefHost = useMemo(() => {
    const group = groupById(open, open.focused);
    const ref = group === undefined ? null : activeRef(group);
    return ref === null ? LOCAL_HOST_KEY : hostOf(ref);
  }, [open]);
  const files = useFiles({
    host: filesHost,
    active: sidebarShown && sidebarView === "files",
    follow: frontRefHost === filesHost ? frontFolder : null,
    shown: shownFiles,
    revision: discovery,
  });
  const { noteOpened, loadListing, setRoot: setFilesRoot } = files;
  // A project's Config or Files asked for while that surface showed another
  // host: pointed in the render that switches it to this PC, after the switch
  // has cleared what the other host's showed (adjusted while rendering, so
  // the scope is never painted against the wrong host).
  if (pendingScope !== null) {
    if (pendingScope.surface === "config" && configHost === pendingScope.host) {
      setPendingScope(null);
      setConfigScope(pendingScope.path);
    } else if (
      pendingScope.surface === "files" &&
      filesHost === pendingScope.host
    ) {
      setPendingScope(null);
      setFilesRoot(pendingScope.path);
    }
  }

  /** Whether long lines wrap in a file - a setting, so it holds for the next file and the next start. */
  const filesWrap = settings?.filesWrap ?? DEFAULT_SETTINGS.filesWrap;
  const setFilesWrap = useCallback(
    (wrap: boolean) => writeSettings({ filesWrap: wrap }),
    [writeSettings],
  );

  /** The project page's Files link: the sidebar's Files view, on that project, on the project's host. */
  const openFilesAt = useCallback(
    (project: Project, host: string = LOCAL_HOST_KEY) => {
      if (filesHost !== host) {
        showHostOn("files", host);
        setPendingScope({ surface: "files", path: project.path, host });
      } else setFilesRoot(project.path);
      setSidebarView("files");
      setSidebarHidden(false);
    },
    [filesHost, showHostOn, setFilesRoot],
  );

  /**
   * A tab clicked brings the sidebar it carries on from (`sidebarFor`), open
   * and pointed at it - its file revealed in the tree, its session or project
   * scrolled to - as though its rail item had been pressed and its row found.
   *
   * A click on a tab, and only that: focus moving between two panes leaves the
   * sidebar alone, or a session beside a file would flip it on every click
   * across. A maximized pane keeps the window; the view still switches, for
   * when the window is given back.
   */
  const { reveal: revealFile } = files;
  const bringSidebarFor = useCallback(
    (ref: PaneRef) => {
      const view = sidebarFor(ref);
      if (view === null) return;
      setSidebarView(view);
      setSidebarHidden(false);
      revealCount.current += 1;
      const seq = revealCount.current;
      if (ref.kind === "file") {
        // Revealed on the host the Files view shows; a file of another host
        // switches the view to it, which then follows the file's folder.
        if (hostOf(ref) === filesHost) {
          revealFile(ref.root, ref.path);
          setFilesRevealSeq(seq);
        } else showHostOn("files", hostOf(ref));
      } else if (ref.kind === "session")
        setTreeReveal({ seq, kind: "session", id: paneId(ref) });
      else if (ref.kind === "project")
        setTreeReveal({ seq, kind: "project", path: ref.path });
    },
    [revealFile, filesHost, showHostOn],
  );

  /**
   * The folder a note is saved, snapshotted and wikilinked as part of: the
   * deepest one Helm knows that holds it. A README under a harness's
   * `repos/helm` belongs to `helm` - the harness's own write guard refuses
   * `repos/` outright, for exactly that reason.
   */
  const scopeOf = useCallback(
    (ref: FileRef): string => {
      // The folders Helm knows are the Files view's host's.
      if (hostOf(ref) !== files.host) return ref.root;
      const lower = ref.path.toLowerCase();
      let best = ref.root;
      for (const scope of files.roots) {
        const root = scope.path.replace(/[\\/]+$/, "");
        if (
          root.length > best.length &&
          (lower.startsWith(`${root.toLowerCase()}\\`) ||
            lower.startsWith(`${root.toLowerCase()}/`))
        ) {
          best = scope.path;
        }
      }
      return best;
    },
    [files.roots, files.host],
  );

  const setDocMode = (ref: FileRef, mode: DocumentMode): void => {
    setDocModes((current) =>
      new Map(current).set(fileKey(ref.path, hostOf(ref)), mode),
    );
    // Editing a preview tab keeps it, as every editor does: the next single
    // click must not replace a tab with a draft in it.
    if (mode === "edit") keepTab(paneId(ref));
  };
  const markDocDirty = useCallback((key: string, dirty: boolean) => {
    setDocDirty((current) => {
      if (current.has(key) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  /**
   * A file, opened to be read beside the session changing it (`openFile`): a
   * single click previews it, a double click or Ctrl+P keeps it.
   *
   * The preview that comes back is worked out here, from the layout on screen,
   * rather than inside the update - an updater has to be pure, and React runs
   * it twice in development to check.
   */
  const filesShownHost = files.host;
  const openFileAt = useCallback(
    (
      root: string,
      path: string,
      keep: boolean,
      at?: QuickOpenAt,
      host: string = filesShownHost,
    ) => {
      // A file of another host's carries it, so its tab reads and writes there.
      const ref: FileRef =
        host === LOCAL_HOST_KEY
          ? { kind: "file", root, path }
          : { kind: "file", root, path, host };
      // A text match opens on its line; anything else opens where the file starts.
      setFileReveals((current) => {
        const key = fileKey(path, host);
        if (at === undefined && !current.has(key)) return current;
        const next = new Map(current);
        if (at === undefined) next.delete(key);
        else next.set(key, { ...at });
        return next;
      });
      const id = paneId(ref);
      const still =
        preview !== null && findTab(open, preview) !== null ? preview : null;
      const placed = openFile(open, ref, still, keep);
      const landed = findTab(placed.layout, id);
      commit((current) => openFile(current, ref, still, keep).layout);
      setPreview(placed.preview);
      // A file sent to the pane a maximized one is hiding gives the window back.
      setMaximized((current) =>
        current === null || current === landed?.group ? current : null,
      );
      if (host === filesShownHost) noteOpened(root, relativeTo(root, path));
    },
    [filesShownHost, open, preview, commit, noteOpened],
  );

  /** A preview tab double-clicked: it stays. */
  const keepTab = useCallback((id: string) => {
    setPreview((current) => (current === id ? null : current));
  }, []);

  const openInEditor = useCallback((path: string, line: number | null) => {
    void helm.invoke("files:openInEditor", { path, line });
  }, []);
  /** True unless the clipboard refused it; a copy a later one replaced counts as done. */
  const copyPath = useCallback(
    async (path: string) =>
      (await helm.invoke("clipboard:write", path)).outcome !== "refused",
    [],
  );

  /**
   * Ctrl+P: a file in the project the Files view is on, which follows the
   * pane in front. With nothing to search yet, the Files view opens instead,
   * and picks a project.
   */
  const filesRoot = files.root;
  const openQuickOpen = useCallback(
    (mode: QuickOpenMode = "files") => {
      if (filesRoot === null) {
        setSidebarView("files");
        setSidebarHidden(false);
        return;
      }
      loadListing(filesRoot);
      setQuickOpenMode(mode);
      setQuickOpenRoot(filesRoot);
    },
    [filesRoot, loadListing],
  );
  /** Ctrl+Shift+F's half: the text of the project Ctrl+P is on. */
  const searchText = useCallback(
    (query: string) =>
      quickOpenRoot === null
        ? Promise.resolve(null)
        : bridgeFor(filesShownHost)
            .invoke("content:search", { scopePath: quickOpenRoot, query })
            .catch(() => null),
    [quickOpenRoot, filesShownHost],
  );

  /**
   * Ctrl+N opens the launcher from anywhere in the window, a focused terminal
   * included - in capture, as Ctrl+Tab is, so xterm never sees it. Claude Code
   * binds nothing to it; a shell would read it as "next history line", and the
   * arrow keys say the same thing there. Not over another dialog, and not
   * during first run.
   *
   * A browser tab's page is the exception: keys typed into it go to that page's
   * own process, not this window, so Ctrl+N there is the page's.
   */
  useEffect(() => {
    if (setupNeeded) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!hasPrimaryModifier(event) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "n") return;
      event.preventDefault();
      event.stopPropagation();
      if (!overlayOpen()) openLauncher();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [setupNeeded, openLauncher]);

  /**
   * Ctrl+P, from anywhere in the window, a focused terminal included - in
   * capture, as Ctrl+N is. Claude Code binds it to the same things it binds
   * Ctrl+N to - the previous line, the previous choice - and the arrow keys
   * do each of those, which is the argument Ctrl+N's handler makes too.
   * Ctrl+Shift+F opens the same dialog on its text half; nothing in Claude
   * Code or a shell binds it.
   */
  useEffect(() => {
    if (setupNeeded) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!hasPrimaryModifier(event) || event.altKey) return;
      const key = event.key.toLowerCase();
      const mode =
        !event.shiftKey && key === "p"
          ? "files"
          : event.shiftKey && key === "f"
            ? "text"
            : null;
      if (mode === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (!overlayOpen()) openQuickOpen(mode);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [setupNeeded, openQuickOpen]);

  /**
   * Ctrl+Shift+P, the plugins' commands - in capture, as Ctrl+P is. Nothing in
   * Claude Code or a shell binds it.
   */
  useEffect(() => {
    if (setupNeeded) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!hasPrimaryModifier(event) || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "p") return;
      event.preventDefault();
      event.stopPropagation();
      if (!overlayOpen()) setPaletteOpen(true);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [setupNeeded]);

  /**
   * Ctrl+Tab cycles every tab in every pane on screen as one ring, and Ctrl+\
   * sends the front tab to the pane beside it. In capture so neither reaches a
   * focused terminal. Ctrl+Shift+Tab is not bound by Claude Code; Shift+Tab
   * alone is (it cycles permission modes) and is deliberately left alone.
   *
   * On macOS the split is Cmd+\, as Helm's other shortcuts are, but the ring
   * stays Ctrl+Tab: Cmd+Tab is the system's app switcher, and Ctrl+Tab is how
   * every Mac browser cycles its tabs.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey) return;
      if (event.key === "\\" && !event.shiftKey && hasPrimaryModifier(event)) {
        event.preventDefault();
        event.stopPropagation();
        splitFocused();
        return;
      }
      if (event.key !== "Tab" || !event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? -1 : 1;
      if (shownMax === null) {
        commit((current) => cycleTab(current, step));
        return;
      }
      // A maximized pane is the whole window, so the ring is its tabs.
      const group = groupById(open, shownMax);
      const ids = group?.tabs.map(paneId) ?? [];
      if (group === undefined || ids.length < 2) return;
      const current = activeRef(group);
      const at = current === null ? -1 : ids.indexOf(paneId(current));
      const next = ids[(at + step + ids.length) % ids.length];
      if (next !== undefined)
        commit((layoutNow) => activateTab(layoutNow, next));
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [commit, open, shownMax, splitFocused]);

  // ---------------------------------------------------------------------------
  // What the tree, the tabs, the crumbs and the status bar say
  // ---------------------------------------------------------------------------

  const now = useNow(30_000);

  /** Each of Helm's sessions' registry record, for how long it has been in its state. */
  const liveByHelmId = useMemo(() => {
    const map = new Map<number, LiveSession>();
    for (const live of machineSessions.sessions) {
      if (live.helmSessionId !== null) map.set(live.helmSessionId, live);
    }
    return map;
  }, [machineSessions.sessions]);

  const profileNames = useMemo(() => {
    const map = new Map<number, string>();
    for (const profile of profileState.profiles)
      map.set(profile.id, profile.name);
    return map;
  }, [profileState.profiles]);

  const stateOf = (session: SessionRecord): TabIndicator =>
    indicatorOf(
      session,
      session.status === "running"
        ? sessionActivity.get(session.id)
        : undefined,
    );

  /**
   * The tree's sessions, under the project each is running in.
   *
   * Helm's own are matched on the project they were launched against, falling
   * back to their working directory; ended ones stay, because their tab does -
   * the scrollback is the record of what happened. Sessions Helm did not start
   * are matched with core's `liveSessionsIn`, the comparison the launch warning
   * uses, so the tree and the warning cannot disagree about whether two paths
   * are one folder.
   */
  const visibleIds = new Set(visible.map(paneId));
  const tree = ((): {
    byPath: Map<string, TreeSession[]>;
    elsewhere: TreeSession[];
  } => {
    const byPath = new Map<string, TreeSession[]>();
    const elsewhere: TreeSession[] = [];
    const known = new Set(
      [...projectsByPath.keys()].map((path) => path.toLowerCase()),
    );
    const add = (key: string, row: TreeSession): void => {
      const rows = byPath.get(key);
      if (rows) rows.push(row);
      else byPath.set(key, [row]);
    };

    const rowOf = (session: SessionRecord): TreeSession => {
      const activity =
        session.status === "running"
          ? sessionActivity.get(session.id)
          : undefined;
      const state = indicatorOf(session, activity);
      const live = liveByHelmId.get(session.id);
      const status = statusHint(activity);
      const id = `session:${String(session.id)}`;
      return {
        id,
        label: sessionLabel(session),
        state,
        note: sessionNote(state, live?.statusSinceMs ?? null, now),
        hint: status === null ? session.cwd : `${session.cwd}\n${status}`,
        outside: false,
        shown:
          id === frontId ? "focused" : visibleIds.has(id) ? "visible" : null,
      };
    };

    // A child is drawn under its parent whatever folder it runs in; every
    // other session is listed under the folder it runs in.
    for (const { session, row } of treeEntries(sessions, rowOf)) {
      const key = (session.projectPath ?? session.cwd).toLowerCase();
      if (known.has(key)) add(key, row);
      else
        elsewhere.push({
          ...row,
          label: `${row.label} · ${folderName(session.cwd)}`,
        });
    }

    for (const project of projectsByPath.values()) {
      for (const live of liveSessionsIn(
        machineSessions.sessions,
        project.path,
      )) {
        if (live.helmSessionId !== null) continue;
        add(project.path.toLowerCase(), {
          id: `pid:${String(live.pid)}`,
          label: live.name ?? "claude",
          state: live.activity,
          note: "outside Helm",
          hint:
            `Started outside Helm, in ${live.cwd ?? project.path}` +
            (statusHint(live) === null ? "" : `\n${statusHint(live)}`),
          outside: true,
          shown: null,
        });
      }
    }
    return { byPath, elsewhere };
  })();

  /**
   * Each host on another computer, under its name after this PC: its folders
   * as its own scan found them, and its sessions under the folder each runs
   * in. One running there is listed whether or not it has a tab here; one that
   * ended is listed while its tab is.
   */
  const treeHosts: TreeHost[] = listedHosts.map((host) => {
    const work = hostWork.byHost.get(host.id);
    const byPath = new Map<string, TreeSession[]>();
    const elsewhere: TreeSession[] = [];
    const known = new Set(
      (work?.discovery?.projects ?? []).map((project) =>
        project.path.toLowerCase(),
      ),
    );
    const tabbed = sessionTabIds(open, host.id);
    // Listed: running, or ended with a tab here, or ended and a child of one
    // that runs - it stays under its parent after its family view has closed
    // it. A child whose parent is not among them stands on its own, naming the
    // parent.
    const hosted = work?.sessions ?? [];
    const running = new Set(
      hosted
        .filter((session) => session.status === "running")
        .map((session) => session.id),
    );
    const listed = hosted.filter(
      (session) =>
        (session.status === "running" ||
          tabbed.has(session.id) ||
          (isChild(session) && running.has(session.parentId as number))) &&
        sessionAt({ id: session.id, host: host.id }) !== null,
    );
    const rowOf = (session: SessionRecord): TreeSession => {
      const there = sessionAt({ id: session.id, host: host.id });
      const id = paneId(sessionRef(session.id, host.id));
      return {
        id,
        label: sessionLabel(session),
        state: there?.indicator ?? null,
        note: there === null ? "" : sessionNote(there.indicator, null, now),
        hint: session.cwd,
        outside: false,
        shown:
          id === frontId ? "focused" : visibleIds.has(id) ? "visible" : null,
      };
    };
    for (const { session, row } of treeEntries(listed, rowOf)) {
      const key = (session.projectPath ?? session.cwd).toLowerCase();
      if (known.has(key)) {
        const rows = byPath.get(key);
        if (rows) rows.push(row);
        else byPath.set(key, [row]);
      } else
        elsewhere.push({
          ...row,
          label: `${row.label} · ${folderName(session.cwd)}`,
        });
    }
    return {
      id: host.id,
      name: host.name,
      connected: connectedHostIds.includes(host.id),
      discovery: work?.discovery ?? null,
      scanning: work?.scanning ?? false,
      scanError: work?.scanError,
      pinnedPaths: work?.pinnedProjects ?? [],
      sessionsByPath: byPath,
      elsewhere,
      selectedPath:
        front?.kind === "project" && hostOf(front) === host.id
          ? front.path
          : null,
      launchingPath,
    };
  });

  /**
   * A press on a session's row in the tree, on `host`: the session whose tab
   * comes forward or opens. A child with no tab whose parent's tab is here
   * shows in that tab's family view first (`pressSessionRow`), the last card
   * shrinking in its place, and no tab is added.
   */
  const pressRow = useCallback(
    (host: string, there: readonly SessionRecord[], id: number) =>
      pressTreeSession(host, there, id, {
        layout: open,
        enabled: showChildren,
        capacityOf: familyCapacity,
        commit,
      }),
    [open, commit, showChildren],
  );

  const openTreeSession = useCallback(
    (id: string) => {
      if (id.startsWith("session:")) {
        // A child's tab comes forward if it has one here, else its parent's
        // does; only a child with neither opens a tab, on this press. Any other
        // session not open here opens in a tab here.
        openSession(pressRow(LOCAL_HOST_KEY, sessions, sessionIdOf(id)).id);
        return;
      }
      // Somebody else's session has no tab; its row in the sessions pane is
      // where what Helm can know about it is.
      setSelectedLivePid(Number(id.slice("pid:".length)));
      openSessions();
    },
    [openSession, openSessions, sessions, pressRow],
  );

  /** What each host's group in the tree asks for, through that host. */
  const treeHostActions = {
    onSelect: (host: string, project: Project) =>
      host === LOCAL_HOST_KEY
        ? openProject(project)
        : openPane({ kind: "project", path: project.path, host }),
    onLaunch: (host: string, project: Project) => void launchOn(host, project),
    onOpenSession: (host: string, id: string) => {
      if (host === LOCAL_HOST_KEY) {
        openTreeSession(id);
        return;
      }
      const there = hostWork.byHost.get(host)?.sessions ?? [];
      const session = there.find(
        (each) => paneId(sessionRef(each.id, host)) === id,
      );
      if (session === undefined) return;
      // The same press as on this PC: the child's tab, else its parent's.
      openRemoteSession(host, pressRow(host, there, session.id).id);
    },
    onTogglePin: (host: string, path: string) =>
      host === LOCAL_HOST_KEY
        ? togglePin(path)
        : hostWork.togglePin(host, path),
    onNewSession: (host: string) =>
      showLauncher(host === LOCAL_HOST_KEY ? frontFolder : null, host),
    onNewHarness: (host: string) => setup.openDialog("new", host),
    onRescan: rescanOn,
    onAddHost: () => setAddingHost(true),
  };

  /** Helm's live sessions by what they are doing, for the status bar. */
  const running = sessions.filter((session) => session.status === "running");
  const waiting = running.filter((session) => stateOf(session) === "waiting");
  const statusCounts = countSessionStates(running, stateOf);

  /** "Needs you", pressed: the next waiting session after the one in front. */
  const showWaiting = (): void => {
    const ids = waiting.map((session) => `session:${String(session.id)}`);
    if (ids.length === 0) return;
    const at = frontId === null ? -1 : ids.indexOf(frontId);
    const next = ids[(at + 1) % ids.length];
    if (next !== undefined) openSession(sessionIdOf(next));
  };

  /**
   * The machine-wide line under the tree: how many sessions are running on
   * this machine and how many of them are not Helm's - the half that changes
   * what somebody does next, and the reason the listing behind it exists.
   */
  const sessionsSummaryLine = ((): string => {
    const all = machineSessions.sessions;
    if (machineSessions.readAtMs === null) return "Reading…";
    if (all.length === 0) return "Nothing running on this machine";
    const outside = all.filter(
      (session) => session.helmSessionId === null,
    ).length;
    const count = `${String(all.length)} on this machine`;
    return outside === 0
      ? `${count} · all in Helm`
      : `${count} · ${String(outside)} outside Helm`;
  })();

  /** One tab, as its pane's strip draws it. */
  const tabFor = (ref: PaneRef): Tab[] => {
    switch (ref.kind) {
      case "session": {
        if (hostOf(ref) !== LOCAL_HOST_KEY) {
          const there = sessionAt(ref);
          if (there === null) return [];
          const label = sessionLabel(there.record);
          const on = hostName(hostOf(ref));
          const status =
            there.record.status === "running"
              ? statusHint(
                  hostWork.byHost.get(hostOf(ref))?.activity.get(ref.id),
                )
              : null;
          return [
            {
              id: paneId(ref),
              title: label,
              host: on,
              hint:
                status === null
                  ? `${label} · ${on} · ${there.record.cwd}`
                  : `${label} · ${on} · ${there.record.cwd}\n${status}`,
              indicator: there.indicator,
              // Its host's link is down: a warning ring until it is back.
              away:
                there.record.status === "running" &&
                hostAway(hostOf(ref)) !== null,
              renamable: true,
            },
          ];
        }
        const session = sessionsById.get(ref.id);
        if (!session) return [];
        const label = sessionLabel(session);
        const status =
          session.status === "running"
            ? statusHint(sessionActivity.get(session.id))
            : null;
        return [
          {
            id: paneId(ref),
            title: label,
            // The CLI's own sentence for why it is blocked, or a program's own
            // error message, verbatim and never matched against: it comes from
            // whichever dialog is on top, and anything that interpreted it
            // would be a second parser of a string the CLI can change freely.
            hint:
              status === null
                ? `${label} · ${session.cwd}`
                : `${label} · ${session.cwd}\n${status}`,
            indicator: stateOf(session),
            renamable: true,
          },
        ];
      }
      case "terminal": {
        const on = hostOf(ref);
        const name =
          (on === LOCAL_HOST_KEY
            ? projectsByPath.get(ref.path)
            : remoteProjectOf(on, ref.path)
          )?.name ?? folderName(ref.path);
        return [
          {
            id: paneId(ref),
            title: truncate(name, 30),
            ...(on === LOCAL_HOST_KEY ? {} : { host: hostName(on) }),
            hint:
              on === LOCAL_HOST_KEY
                ? `Terminal · ${ref.path}`
                : `Terminal · ${hostName(on)} · ${ref.path}`,
            icon: <ConsoleIcon width={13} height={13} />,
          },
        ];
      }
      case "sessions":
        return [
          {
            id: paneId(ref),
            title: "Sessions",
            hint: sessionsSummaryLine,
            icon: <TerminalIcon width={13} height={13} />,
          },
        ];
      case "history":
        return [
          {
            id: paneId(ref),
            title: "Session history",
            hint:
              historyHost === LOCAL_HOST_KEY
                ? (historyState.summary?.historyFile ??
                  "Every session on this machine")
                : `Every session on ${hostName(historyHost)}`,
            icon: <HistoryIcon width={13} height={13} />,
          },
        ];
      case "config":
        return [
          {
            id: paneId(ref),
            title: "Config",
            hint:
              configHost === LOCAL_HOST_KEY
                ? (configState.scope?.path ??
                  "Browse and edit .claude configuration")
                : `${hostName(configHost)} · ${configState.scope?.path ?? ".claude configuration"}`,
            icon: <SlidersIcon width={13} height={13} />,
          },
        ];
      case "settings":
        return [
          {
            id: paneId(ref),
            title: "Settings",
            hint: "Helm's own settings",
            icon: <GearIcon width={13} height={13} />,
          },
        ];
      case "plugin": {
        const on = hostOf(ref);
        const plugin = pluginsOn(on).get(ref.plugin);
        const surface = plugin?.tabs[ref.tab];
        if (plugin === undefined || surface === undefined) return [];
        const title = ref.title ?? surface.title;
        const isPreview = paneId(ref) === preview;
        // Another host's plugin tab names its host, as its session tabs do.
        const owner =
          on === LOCAL_HOST_KEY
            ? plugin.name
            : `${plugin.name} · ${hostName(on)}`;
        return [
          {
            id: paneId(ref),
            title: truncate(title, 30),
            ...(on === LOCAL_HOST_KEY ? {} : { host: hostName(on) }),
            hint: isPreview
              ? `${title} - ${owner}\n${PREVIEW_HINT}`
              : `${title} - ${owner}`,
            icon: <PluginIcon url={plugin.icon} size={13} />,
            preview: isPreview,
          },
        ];
      }
      case "plugin-pages": {
        // One tab, named for the plugin, as the Browser tab is named for what
        // it is. The pages are in its own strip; the hint says what is in
        // front, for a tab that is not.
        const plugin = plugins.get(ref.plugin);
        if (plugin === undefined) return [];
        const count = ref.pages.length;
        const page = frontPluginPage(ref);
        const showing =
          page === null ? "" : `, showing ${pluginPageTitle(page, plugin)}`;
        return [
          {
            id: paneId(ref),
            title: truncate(plugin.name, 30),
            hint: `${plugin.name}: ${String(count)} ${count === 1 ? "page" : "pages"}${showing}`,
            icon: <PluginIcon url={plugin.icon} size={13} />,
          },
        ];
      }
      case "browser": {
        // One tab, named for what it is. The pages, their titles and the
        // sessions that opened them are in its own strip; the hint says what
        // is in front, for a Browser tab that is not.
        const front =
          frontPage === null ? undefined : browserViews.get(frontPage);
        const count = browserViews.size;
        const showing =
          front === undefined
            ? ""
            : front.url === ""
              ? "a new tab"
              : front.title === ""
                ? front.url
                : front.title;
        return [
          {
            id: paneId(ref),
            title: "Browser",
            hint: `${String(count)} ${count === 1 ? "tab" : "tabs"}${showing === "" ? "" : `, showing ${showing}`}`,
            icon: <GlobeIcon width={13} height={13} />,
          },
        ];
      }
      case "restore":
        return restoreOffer === null
          ? []
          : [
              {
                id: paneId(ref),
                title: "Restore sessions",
                hint: `What ${LOCAL_HOST_NAME} was running when it stopped`,
                icon: <HistoryIcon width={13} height={13} />,
              },
            ];
      case "project": {
        const remote = hostOf(ref) !== LOCAL_HOST_KEY;
        const project = remote
          ? remoteProjectOf(hostOf(ref), ref.path)
          : projectsByPath.get(ref.path);
        if (!project) return [];
        const Icon = KIND_ICON[project.kind];
        return [
          {
            id: paneId(ref),
            title: project.name,
            ...(remote ? { host: hostName(hostOf(ref)) } : {}),
            hint: remote
              ? `${hostName(hostOf(ref))} · ${project.path}`
              : project.path,
            icon: <Icon width={13} height={13} />,
          },
        ];
      }
      case "file": {
        const on = hostOf(ref);
        const where =
          on === LOCAL_HOST_KEY ? ref.path : `${hostName(on)} · ${ref.path}`;
        return [
          {
            id: paneId(ref),
            title: folderName(ref.path),
            ...(on === LOCAL_HOST_KEY ? {} : { host: hostName(on) }),
            hint: paneId(ref) === preview ? `${where}\n${PREVIEW_HINT}` : where,
            icon: <DocIcon width={13} height={13} />,
            mono: true,
            preview: paneId(ref) === preview,
            dirty: docDirty.has(fileKey(ref.path, on)),
          },
        ];
      }
    }
  };

  /** The crumb under a session's tab. */
  const crumbFor = (ref: PaneRef | null): ReactNode => {
    if (ref?.kind === "file") {
      const view = files.tabs.get(fileKey(ref.path, hostOf(ref)))?.view ?? null;
      const kind = documentKind(ref.path);
      return (
        <FileCrumb
          relPath={view?.relPath ?? relativeTo(ref.root, ref.path)}
          changes={view?.changes ?? null}
          trailing={
            kind === null ? undefined : (
              <DocumentModeSwitch
                kind={kind}
                mode={docModes.get(fileKey(ref.path, hostOf(ref))) ?? "preview"}
                onChange={(mode) => setDocMode(ref, mode)}
              />
            )
          }
        />
      );
    }
    if (ref?.kind === "terminal") {
      const on = hostOf(ref);
      return (
        <PaneCrumb
          place={
            (on === LOCAL_HOST_KEY
              ? projectsByPath.get(ref.path)
              : remoteProjectOf(on, ref.path)
            )?.name ?? folderName(ref.path)
          }
          hint={
            on === LOCAL_HOST_KEY ? ref.path : `${hostName(on)} · ${ref.path}`
          }
        />
      );
    }
    if (ref?.kind !== "session") return null;
    if (hostOf(ref) !== LOCAL_HOST_KEY) {
      const there = sessionAt(ref);
      if (there === null) return null;
      return (
        <PaneCrumb
          place={folderName(there.record.cwd)}
          hint={`${hostName(hostOf(ref))} · ${there.record.cwd}`}
          branch={there.record.branch}
        />
      );
    }
    const session = sessionsById.get(ref.id);
    if (!session) return null;
    const project =
      session.projectPath === null
        ? undefined
        : projectsByPath.get(session.projectPath);
    return (
      <PaneCrumb
        place={project?.name ?? folderName(session.cwd)}
        hint={session.cwd}
        branch={session.branch}
        profile={
          session.profileId === null
            ? null
            : (profileNames.get(session.profileId) ?? null)
        }
        status={crumbStatus(
          session,
          stateOf(session),
          liveByHelmId.get(session.id)?.statusSinceMs ?? null,
          now,
          session.status === "running"
            ? (sessionActivity.get(session.id)?.message ?? null)
            : null,
        )}
      />
    );
  };

  // ---------------------------------------------------------------------------
  // Dialogs
  // ---------------------------------------------------------------------------

  /**
   * "This session is still running", asked by the main process and answered
   * here. Main owns process lifetime, so it owns the question; the renderer
   * owns everything the user looks at, so it draws it. The answer is sent only
   * while a request is pending: a second reply to an id main has resolved is a
   * reply for a decision that has been taken.
   */
  // Each host asks on its own bridge, and is answered on it: one on another
  // computer names itself in what it asks (`hostTabs.ts`).
  const { ask: confirmAsk, answer: answerConfirm } =
    useSessionConfirm(HOST_BRIDGES);
  const confirmRequest = confirmAsk?.request ?? null;

  /**
   * Settings' Stop host: how many sessions it ends, asked here, then the stop.
   * The count is every session running in the host, whichever device started
   * it, read when the button is pressed.
   */
  const [stopHostAsk, setStopHostAsk] = useState<number | null>(null);
  const [stopHostError, setStopHostError] = useState<string | null>(null);
  const askStopHost = useCallback(() => {
    setStopHostError(null);
    helm
      .invoke("windowSessions:hostSessionCount")
      .then(setStopHostAsk, (error: unknown) =>
        setStopHostError(
          error instanceof Error ? error.message : String(error),
        ),
      );
  }, []);
  const stopHost = useCallback(() => {
    setStopHostAsk(null);
    helm
      .invoke("windowSessions:stopHost")
      .catch((error: unknown) =>
        setStopHostError(
          error instanceof Error ? error.message : String(error),
        ),
      );
  }, []);

  /** Restart host to update, on the user's click only (`useRestartHost`). */
  const restartHostDeps = useMemo<RestartHostDeps>(
    () => ({
      ask: () => helm.invoke("windowSessions:restartAsk"),
      // Main resolves once it has the new host. A window that old host
      // refused waits to try again, and connects to the new one now.
      restart: () =>
        helm.invoke("windowSessions:restartHost").then(reconnectLocalHost),
      onError: setStopHostError,
    }),
    [],
  );
  const restartHostFlow = useRestartHost(restartHostDeps);
  const restartHostAsk = restartHostFlow.offer;
  const { ask: askRestart } = restartHostFlow;
  const askRestartHost = useCallback(() => {
    setStopHostError(null);
    askRestart();
  }, [askRestart]);

  /**
   * Rendered by both branches below: main holds the window's `close` open on
   * this promise, so a branch that did not draw the dialog would be a branch
   * Helm could not quit from until the fallback timer ran out.
   */
  const confirmDialog =
    confirmRequest !== null ? (
      <ConfirmSessionDialog
        kind={confirmRequest.kind}
        message={confirmRequest.message}
        detail={confirmRequest.detail}
        folder={confirmRequest.folder}
        confirmLabel={confirmRequest.confirmLabel}
        keepLabel={confirmRequest.keepLabel}
        sessionNames={confirmRequest.sessionNames}
        onConfirm={() => answerConfirm(true)}
        onKeep={() => answerConfirm(false, true)}
        onCancel={() => answerConfirm(false)}
      />
    ) : stopHostAsk === null ? null : (
      <ConfirmSessionDialog
        kind="stop-host"
        message={
          stopHostAsk === 0
            ? "No session is running in this PC’s host."
            : `Stopping this PC’s host ends ${String(stopHostAsk)} session${stopHostAsk === 1 ? "" : "s"}.`
        }
        detail="Every session running in it ends, whichever device started it, and none is offered back. Helm starts the host again when it next needs it."
        confirmLabel="Stop host"
        sessionNames={[]}
        onConfirm={stopHost}
        onCancel={() => setStopHostAsk(null)}
      />
    );
  const restartDialog =
    restartHostAsk === null || info === null ? null : (
      <ConfirmSessionDialog
        kind="restart-host"
        message={restartHostQuestion(restartHostAsk, info.version)}
        detail={restartHostDetail(restartHostAsk)}
        confirmLabel="Restart host"
        confirmTone={restartHostConfirmTone(restartHostAsk)}
        sessionNames={[]}
        onConfirm={restartHostFlow.confirm}
        onCancel={restartHostFlow.cancel}
      />
    );

  /** Rendered by both branches: creating a harness is a first-run action and
   * an every-day one, and two copies of the dialog would drift apart. */
  const harnessDialog =
    setup.dialog === null || templates.managerOpen ? null : (
      <NewHarnessDialog
        {...(setup.dialogHost === LOCAL_HOST_KEY
          ? {}
          : { host: hostName(setup.dialogHost) })}
        onDirChange={setup.typeDialogDir}
        mode={setup.dialog}
        dir={setup.dialogDir}
        onChooseDir={setup.chooseDialogDir}
        onModeChange={setup.setDialogMode}
        problems={setup.dialogProblems}
        busy={setup.creating}
        templates={setup.templates}
        template={setup.template}
        onTemplateChange={setup.chooseTemplate}
        templatesDir={setup.templatesDir}
        {...(setup.dialogHost === LOCAL_HOST_KEY
          ? { onManageTemplates: templates.openManager }
          : {})}
        templateProblems={setup.templateProblems}
        preview={setup.templatePreview}
        onCreate={setup.createHarness}
        onCancel={setup.closeDialog}
      />
    );

  /**
   * The template manager, and the dialog that freezes a folder into one. The
   * harness dialog is **withheld while this is up** - two `Overlay`s is two
   * scrims - and withholding rather than closing keeps what was typed into it.
   */
  const templateDialogs =
    templates.saveDialog !== null ? (
      <SaveAsTemplateDialog
        kind={templates.saveDialog.kind}
        dir={templates.saveDialog.dir}
        {...(templates.saveDialog.kind === "folder"
          ? { onChooseDir: templates.chooseSaveDir }
          : {})}
        preview={templates.savePreview}
        busy={templates.saveBusy}
        problems={templates.saveProblems}
        onSave={templates.save}
        onCancel={templates.closeSaveDialog}
      />
    ) : templates.managerOpen ? (
      <TemplateManager
        templates={templates.templates}
        templatesDir={templates.templatesDir}
        listProblems={templates.listProblems}
        selected={templates.selected}
        onSelect={templates.select}
        detail={templates.detail}
        scopes={templates.scopes}
        importScope={templates.importScope}
        onImportScopeChange={templates.setImportScope}
        importTree={templates.importTree}
        busy={templates.busy}
        problems={templates.problems}
        notice={templates.notice}
        onCreate={templates.create}
        onSaveMetadata={templates.saveMetadata}
        onDelete={templates.remove}
        onReveal={launcher.reveal}
        onMakeSubstitutable={templates.makeSubstitutable}
        onImport={templates.importFiles}
        onImportFolder={templates.openImportFolder}
        onClose={() => {
          templates.closeManager();
          // The harness dialog behind this may be showing a picker built before
          // a template was created, renamed or deleted.
          setup.refreshTemplates();
        }}
      />
    ) : null;

  /**
   * New, Rename and Delete for one entry in a `.claude` tree. Rendered beside
   * the other modals rather than inside the console: a dialog nested in a pane
   * that a split can narrow is a dialog that gets clipped.
   */
  const configEntryDialog =
    configState.scope === null ||
    configState.entryDialog === null ? null : configState.entryDialog ===
      "new" ? (
      <ConfigNewDialog
        scope={configState.scope}
        files={configState.tree?.files ?? []}
        busy={configState.entryBusy}
        error={configState.entryError}
        onCreate={configState.createFile}
        onCancel={() => configState.openEntryDialog(null)}
      />
    ) : configState.selected === null ? null : configState.entryDialog ===
      "rename" ? (
      <ConfigRenameDialog
        scope={configState.scope}
        file={configState.selected}
        files={configState.tree?.files ?? []}
        busy={configState.entryBusy}
        error={configState.entryError}
        onRename={configState.renameFile}
        onCancel={() => configState.openEntryDialog(null)}
      />
    ) : (
      <ConfigDeleteDialog
        file={configState.selected}
        files={configState.tree?.files ?? []}
        busy={configState.entryBusy}
        error={configState.entryError}
        onDelete={configState.deleteFile}
        onCancel={() => configState.openEntryDialog(null)}
      />
    );

  /**
   * Setup owns the whole window rather than sitting in a tab: with no roots
   * there is no tree, no config scope and no content, and a launcher painted
   * empty behind a dialog would be four broken surfaces framing one that works.
   */
  if (setup.needed) {
    return (
      <div className="flex h-full w-full flex-col bg-bg text-fg">
        <TitleBar />
        <div className="min-h-0 flex-1">
          <SetupPane
            status={setup.status}
            roots={settings?.scanRoots ?? []}
            suggestions={setup.suggestions}
            suggestionsError={setup.suggestionsError}
            projectCount={discovery?.projects.length ?? 0}
            scanning={launcher.scanning}
            checking={setup.checking}
            onRecheck={setup.recheck}
            onLocateClaude={setup.locateClaude}
            onAddFolder={launcher.addRoot}
            onAcceptSuggestion={setup.acceptSuggestion}
            onCreateHarness={() => setup.openDialog("new")}
            onConvertFolder={() => setup.openDialog("convert")}
            onFinish={setup.finish}
          />
        </div>
        {harnessDialog}
        {templateDialogs}
        {confirmDialog}
        {restartDialog}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // The pages
  // ---------------------------------------------------------------------------

  /** Whether `path` is one of the scanned folders - what removal can act on. */
  const isRoot = (path: string): boolean =>
    isScanRoot(settings?.scanRoots ?? [], path);

  /** The harness a project *is*, when it is one - for its `template:`. */
  const harnessAt = (path: string): Harness | null =>
    discovery?.harnesses.find(
      (harness) => harness.path.toLowerCase() === path.toLowerCase(),
    ) ?? null;

  const renderProject = (project: Project): JSX.Element => {
    const harness = harnessAt(project.path);
    const here = liveSessionsIn(machineSessions.sessions, project.path);
    return (
      <ProjectColumn
        path={project.path}
        windowsBuild={info?.windowsBuild ?? null}
        shells={shells}
        heightPct={savedShellHeight}
        onHeightChange={setShellHeight}
      >
        <LocalProjectPane
          key={project.path}
          project={project}
          activity={sessionActivityIn(sessionState.sessions, project.path)}
          harness={harness}
          onReveal={launcher.reveal}
          onLaunch={(p) => void launch(p)}
          launching={launchingPath === project.path}
          launchError={sessionState.launchError}
          liveHere={here.length === 0 ? EMPTY_LIVE : here}
          onSaveAsProfile={(p) => {
            setSaveProblems([]);
            // Seeded with what is on screen: this project as the root, and
            // itself composed, which is the launch the button is beside.
            setEditing({
              ...blankProfile(p.path, p.name),
              overlays: [p.path],
              access: [p.path],
            });
          }}
          onOpenConfig={openConfigAt}
          onOpenFiles={openFilesAt}
          // A harness only: it is the one kind of project with a layout to
          // freeze. Decided here because whether a project is a harness root is
          // discovery's answer, not the page's.
          {...(harness !== null
            ? { onSaveAsTemplate: (p: Project) => templates.openSaveAs(p.path) }
            : {})}
          // Only where this project *is* a scan root, which is the whole of what
          // removal can act on.
          {...(isRoot(project.path)
            ? {
                onRemoveRoot: (p: Project) => {
                  // The shell goes with the page, exactly as it does on close:
                  // removing a folder takes it out of discovery, which drops its
                  // tab without going through the close button, and nothing
                  // else would end the pty.
                  void disposeShell(p.path);
                  launcher.removeRoot(p.path);
                },
              }
            : {})}
        />
      </ProjectColumn>
    );
  };

  const currentSettings = settings ?? DEFAULT_SETTINGS;
  const remoteHosts = listedHosts;
  const tabbedThere = (host: string): Set<number> => sessionTabIds(open, host);
  /** What the status bar says about each host, this PC first: what quitting does there, and the setting that decides. */
  const statusHosts = [
          {
            id: LOCAL_HOST_KEY,
            name: LOCAL_HOST_LABEL,
            quitEnds: quitEndsSessions(currentSettings),
            versions: localVersions,
            onRestart: askRestartHost,
            onOpen: () =>
              openSettings(localVersions === null ? "sessions" : "hosts"),
          },
          ...remoteHosts.map((host) => {
            const lastLine = failedLastLine(
              remoteView[host.id]?.connection ?? null,
            );
            return {
              id: host.id,
              name: host.name,
              quitEnds: quitEndsSessions(currentSettings, host.id),
              retrying: remoteView[host.id]?.connection?.state !== "connected",
              roundTripMs: remoteView[host.id]?.roundTripMs ?? null,
              // Its ssh or command could not get in: what it said, and the line to try by hand.
              unreachable:
                lastLine === null
                  ? null
                  : { lastLine, tryLine: lineToTryByHand(host) },
              onOpen: () => openSettings("hosts"),
            };
          }),
        ];
  /** The sessions pane's group for each remote host, in the order they were added; none with no remote host. */
  const sessionsPaneHosts = remoteHosts.map((host) => {
    const connection = remoteView[host.id]?.connection ?? null;
    return {
      id: host.id,
      name: host.name,
      connected: connection?.state === "connected",
      sessions: (remoteView[host.id]?.sessions ?? []).map((session) => {
        const id = Number(session.key.slice(host.id.length + 1));
        return {
          ...session,
          openHere: tabbedThere(host.id).has(id),
          ports: remoteView[host.id]?.resources.get(id)?.ports ?? null,
          forwarded: new Map(
            forwards
              .filter(
                (forward) => forward.host === host.id && forward.session === id,
              )
              .map((forward) => [forward.port, forward.local] as const),
          ),
          portProblem: portProblems.get(session.key) ?? null,
        };
      }),
      onOpenPort: (key: string, port: number) =>
        openRemotePort(
          host.id,
          Number(key.slice(host.id.length + 1)),
          key,
          port,
        ),
      onOpenSession: (key: string) =>
        openRemoteSession(host.id, Number(key.slice(host.id.length + 1))),
      onEndSession: (key: string) =>
        closeRemoteSession(host.id, Number(key.slice(host.id.length + 1))),
      // A floti too old or newer than this Helm, with both versions; too old
      // offers the same yes-first update Settings > Hosts does.
      floti:
        connection?.state === "tooOld" || connection?.state === "newer"
          ? {
              verdict: connection.state,
              host: connection.host,
              client: connection.client,
            }
          : null,
      onUpdateFloti: () => {
        openSettings("hosts");
        setHostUpdateRequest((last) => ({
          id: host.id,
          nonce: (last?.nonce ?? 0) + 1,
        }));
      },
    };
  });

  /** Settings > Plugins, Secrets and each plugin's page; every other section is `SettingsPane`'s. */
  const renderSettings = (): JSX.Element => {
    if (settingsSection === "secrets") {
      return (
        <SecretsPage
          state={pluginSettings.secrets}
          plugins={secretChoices}
          onSave={pluginSettings.saveSecret}
          onRemove={pluginSettings.removeSecret}
        />
      );
    }
    if (settingsPlugin !== null) {
      const { path, id } = settingsPlugin;
      return (
        <PluginPage
          key={path}
          plugin={settingsPlugin}
          plugins={pluginState.list ?? []}
          metrics={pluginSettings.metrics}
          log={pluginSettings.log}
          secrets={pluginSettings.secrets}
          onSetEnabled={(enabled) => pluginSettings.setEnabled(path, enabled)}
          onSetTools={(enabled) => pluginSettings.setTools(path, enabled)}
          onReload={() => pluginSettings.reload(path)}
          ownSecrets={() => pluginSettings.ownSecrets(path)}
          onRemove={(deleteSecrets) => {
            pluginSettings.remove(path, deleteSecrets);
            setSettingsSection("plugins");
          }}
          onSetSetting={(key, value) =>
            id === null
              ? Promise.resolve("The plugin is not loaded.")
              : pluginSettings.setSetting(id, key, value)
          }
          onSaveSecret={pluginSettings.saveSecret}
          onRemoveSecret={pluginSettings.removeSecret}
        />
      );
    }
    if (
      settingsSection === "plugins" ||
      settingsSection.startsWith("plugin:")
    ) {
      return (
        <PluginsPage
          plugins={shownPluginState.list}
          unavailable={shownPluginState.error}
          addError={pluginSettings.addError}
          onAdd={pluginSettings.add}
          onOpen={(path) => setSettingsSection(pluginSection(path))}
          hostChoice={hostChoiceFor("plugins")}
          {...(pluginsHost === LOCAL_HOST_KEY
            ? {}
            : { remoteHost: hostName(pluginsHost) })}
        />
      );
    }
    return renderHelmSettings();
  };

  const renderHelmSettings = (): JSX.Element => (
    <SettingsPane
      section={settingsSection}
      status={setup.status}
      checking={setup.checking}
      onRecheck={setup.recheck}
      onLocateClaude={setup.locateClaude}
      onClearClaudeOverride={launcher.clearClaudePath}
      roots={settings?.scanRoots ?? []}
      projectCount={discovery?.projects.length ?? 0}
      scanning={launcher.scanning}
      onAddRoot={launcher.addRoot}
      onRemoveRoot={launcher.removeRoot}
      pinnedProjects={
        settings?.pinnedProjects ?? DEFAULT_SETTINGS.pinnedProjects
      }
      // The same writer the tree's star goes through, so the two surfaces
      // cannot hold different ideas of what is pinned.
      onUnpinProject={togglePin}
      appearance={{
        theme: settings?.theme ?? DEFAULT_SETTINGS.theme,
        themeDark: settings?.themeDark ?? DEFAULT_SETTINGS.themeDark,
        themeLight: settings?.themeLight ?? DEFAULT_SETTINGS.themeLight,
        paneGap: settings?.paneGap ?? DEFAULT_SETTINGS.paneGap,
        cornerRadius: settings?.cornerRadius ?? DEFAULT_SETTINGS.cornerRadius,
        density: settings?.density ?? DEFAULT_SETTINGS.density,
        accentColor: settings?.accentColor ?? DEFAULT_SETTINGS.accentColor,
      }}
      onAppearanceChange={writeSettings}
      themes={themes.listing}
      themeState={themes.state}
      onOpenThemesFolder={themes.openFolder}
      onDuplicateTheme={themes.duplicate}
      usageDisplay={settings?.usageDisplay ?? "percent"}
      updateCheck={settings?.updateCheck ?? DEFAULT_SETTINGS.updateCheck}
      onUpdateCheckChange={(updateCheck) => writeSettings({ updateCheck })}
      onUsageDisplayChange={launcher.setUsageDisplay}
      appVersion={info?.version ?? null}
      // From `app:info` rather than from a check's result: the states that
      // produce no result are exactly the ones where somebody wants this link.
      releasesUrl={info?.releasesUrl ?? null}
      // `attempted`, not `answered` - see the narrowing above `update`.
      update={check.attempted}
      updateChecking={check.checking}
      onCheckForUpdate={check.check}
      onOpenReleases={() => {
        if (info?.releasesUrl !== undefined)
          void helmOpenExternal(info.releasesUrl);
      }}
      // The same fact the status bar's cycle turns on, from the same snapshot.
      hasCostEstimate={usage.snapshot?.spend != null}
      terminal={terminalSettings}
      onTerminalChange={launcher.writeSettings}
      // The stack the terminals are actually running, so the preview well
      // cannot show a font the panes are not using.
      terminalFontStack={terminalFontStack(terminalSettings.terminalFontFamily)}
      shells={shells}
      onLocateShell={locateShell}
      onShellPath={chooseShellPath}
      // The archive's own figures, from the one subscription the history pane
      // reads them from, so the two cannot disagree about how much is stored.
      archiveStats={historyState.archiveStats}
      transcriptArchiveMaxBytes={
        settings?.transcriptArchiveMaxBytes ??
        DEFAULT_SETTINGS.transcriptArchiveMaxBytes
      }
      // The authored templates, so the built-in Minimal row does not make an
      // empty templates folder read as one that has something in it.
      templateCount={
        templates.templates.filter((choice) => !choice.builtIn).length
      }
      templatesDir={templates.templatesDir}
      onManageTemplates={templates.openManager}
      onRevealTemplates={() => launcher.reveal(templates.templatesDir)}
      browserReach={settings?.browserReach ?? DEFAULT_SETTINGS.browserReach}
      onBrowserReachChange={(browserReach) => writeSettings({ browserReach })}
      browserSearch={settings?.browserSearch ?? DEFAULT_SETTINGS.browserSearch}
      onBrowserSearchChange={(browserSearch) =>
        writeSettings({ browserSearch })
      }
      browserMcp={settings?.browserMcp ?? DEFAULT_SETTINGS.browserMcp}
      onBrowserMcpChange={(browserMcp) => writeSettings({ browserMcp })}
      browserMcpLocalOnly={
        settings?.browserMcpLocalOnly ?? DEFAULT_SETTINGS.browserMcpLocalOnly
      }
      onBrowserMcpLocalOnlyChange={(browserMcpLocalOnly) =>
        writeSettings({ browserMcpLocalOnly })
      }
      sessionMcp={settings?.sessionMcp ?? DEFAULT_SETTINGS.sessionMcp}
      onSessionMcpChange={(sessionMcp) => writeSettings({ sessionMcp })}
      sessionAgents={settings?.sessionAgents ?? DEFAULT_SETTINGS.sessionAgents}
      onSessionAgentsChange={(sessionAgents) =>
        writeSettings({ sessionAgents })
      }
      agentLimits={{
        agentChildrenPerParent:
          settings?.agentChildrenPerParent ??
          DEFAULT_SETTINGS.agentChildrenPerParent,
        agentSessionsPerHost:
          settings?.agentSessionsPerHost ??
          DEFAULT_SETTINGS.agentSessionsPerHost,
        agentHeavyPerHost:
          settings?.agentHeavyPerHost ?? DEFAULT_SETTINGS.agentHeavyPerHost,
        agentDepth: settings?.agentDepth ?? DEFAULT_SETTINGS.agentDepth,
        agentStartsPerParent:
          settings?.agentStartsPerParent ??
          DEFAULT_SETTINGS.agentStartsPerParent,
      }}
      onAgentLimitsChange={(limits) => writeSettings(limits)}
      showChildrenInParentTab={
        settings?.showChildrenInParentTab ??
        DEFAULT_SETTINGS.showChildrenInParentTab
      }
      onShowChildrenInParentTabChange={(showChildrenInParentTab) =>
        writeSettings({ showChildrenInParentTab })
      }
      restoreWithoutAsking={
        settings?.restoreWithoutAsking ?? DEFAULT_SETTINGS.restoreWithoutAsking
      }
      onRestoreWithoutAskingChange={(restoreWithoutAsking) =>
        writeSettings({ restoreWithoutAsking })
      }
      quitSessions={
        quitEndsSessions(settings ?? DEFAULT_SETTINGS) ? "end" : "keep"
      }
      // Only this PC's entry: a later host's is its own, and Settings keeps it.
      onQuitSessionsChange={(choice) =>
        writeSettings({
          quitSessions: {
            ...(settings ?? DEFAULT_SETTINGS).quitSessions,
            [LOCAL_HOST_KEY]: choice,
          },
        })
      }
      onStopHost={askStopHost}
      hostLogFile={info?.hostLogFile ?? null}
      // Each host's own quit choice, Keep them running until set, and where
      // main's link to it stands.
      hosts={remoteHosts.map((host) => ({
        host,
        quit: quitChoice(currentSettings, host.id),
        connection: remoteView[host.id]?.connection ?? null,
      }))}
      onAddHost={() => setAddingHost(true)}
      // Forgets it on this device with its quit choice; nothing on it ends.
      onRemoveHost={(id) =>
        writeSettings(withoutRemoteHost(currentSettings, id))
      }
      onHostQuitChange={(id, choice) =>
        writeSettings({
          quitSessions: { ...currentSettings.quitSessions, [id]: choice },
        })
      }
      // Main checks, installs and updates floti there, after the yes the
      // window asks for; the window never says what to run.
      hostInstall={hostInstall}
      // The path Helm installed floti at there, which every line run there
      // starts with from now on.
      onHostInstalled={(id, floti, system) =>
        writeSettings({
          hosts: currentSettings.hosts.map((host) =>
            host.id === id ? { ...host, floti, system } : host,
          ),
        })
      }
      hostUpdateRequest={hostUpdateRequest}
      onReconnectHost={(id) => remoteHostLinks.reconnect(id)}
      localHost={
        localVersions === null
          ? null
          : { versions: localVersions, onRestart: askRestartHost }
      }
      devices={devicesSettings}
      filesWrap={filesWrap}
      onFilesWrapChange={setFilesWrap}
      onTranscriptArchiveMaxBytesChange={(transcriptArchiveMaxBytes) =>
        writeSettings({ transcriptArchiveMaxBytes })
      }
    />
  );

  /**
   * A plugin's one tab: its strip of pages, and the page in front under it.
   * Pages behind keep running, parked by `pluginFrames.ts` as a tab behind
   * another does. A page whose tab the plugin no longer declares is not drawn.
   */
  const renderPluginPages = (ref: PluginPagesRef): ReactNode => {
    const plugin = plugins.get(ref.plugin);
    if (plugin === undefined) {
      return pluginState.error === null ? null : (
        <PluginsUnavailable
          reason={pluginState.error}
          className="absolute inset-0"
        />
      );
    }
    const pages = ref.pages.filter(
      (page) => plugin.tabs[page.tab] !== undefined,
    );
    const shown = frontPluginPage({ ...ref, pages });
    const surface = shown === null ? undefined : plugin.tabs[shown.tab];
    const shownId = shown === null ? null : pluginPageId(ref.plugin, shown);
    const holder = findTab(open, paneId(ref));
    const icon = <PluginIcon url={plugin.icon} size={13} />;
    return (
      <div className="absolute inset-0 flex flex-col">
        <PluginPages
          label={`${plugin.name} pages`}
          pages={pages.map((page) => {
            const title = pluginPageTitle(page, plugin);
            const id = pluginPageId(ref.plugin, page);
            const isPreview = id === pagePreviews.get(ref.plugin);
            return {
              id,
              title: truncate(title, 30),
              hint: isPreview
                ? `${title} - ${plugin.name}\n${PREVIEW_HINT}`
                : `${title} - ${plugin.name}`,
              preview: isPreview,
            };
          })}
          activeId={shownId}
          icon={icon}
          focused={holder !== null && holder.group === open.focused}
          onActivate={(id) =>
            commit((current) => activatePluginPage(current, ref.plugin, id))
          }
          onClose={(id) =>
            commit((current) => closePluginPage(current, ref.plugin, id))
          }
          onMove={(id, toIndex) =>
            commit((current) =>
              movePluginPage(current, ref.plugin, id, toIndex),
            )
          }
          onKeep={(id) =>
            setPagePreviews((current) =>
              withoutPreview(current, ref.plugin, id),
            )
          }
        />
        {shown !== null && shownId !== null && surface !== undefined && (
          <PluginFrame
            spec={{
              key: shownId,
              plugin: ref.plugin,
              revision: plugin.revision,
              url: surface.url,
              surface: "tab",
              name: shown.tab,
              params: shown.params,
              title: shown.title ?? surface.title,
            }}
            pluginName={plugin.name}
            onOpenSettings={() => openSettings(pluginSection(plugin.path))}
            className="min-h-0 flex-1"
          />
        )}
      </div>
    );
  };

  /** Whatever a non-session tab shows, in a pane that is `compact` when it shares the width. */
  const renderPage = (ref: PaneRef, compact: boolean): ReactNode => {
    switch (ref.kind) {
      case "project": {
        if (hostOf(ref) !== LOCAL_HOST_KEY) {
          const host = hostOf(ref);
          const project = remoteProjectOf(host, ref.path);
          return project ? (
            <ProjectColumn
              path={project.path}
              host={host}
              hostName={hostName(host)}
              windowsBuild={null}
              heightPct={savedShellHeight}
              onHeightChange={setShellHeight}
            >
              <ProjectPane
                key={paneId(ref)}
                project={project}
                host={hostName(host)}
                onLaunch={(p) => void launchOn(host, p)}
                onOpenConfig={(p) => openConfigAt(p, host)}
                onOpenFiles={(p) => openFilesAt(p, host)}
                onSaveAsProfile={(p) => saveAsProfileOn(host, p)}
                launching={launchingPath === project.path}
                launchError={
                  remoteLaunchError !== null &&
                  remoteLaunchError.host === host &&
                  remoteLaunchError.path === project.path
                    ? remoteLaunchError.text
                    : null
                }
              />
            </ProjectColumn>
          ) : null;
        }
        const project = projectsByPath.get(ref.path);
        return project ? renderProject(project) : null;
      }
      case "history":
        return (
          <SessionHistory
            {...sessionHistoryProps(historyState)}
            hostChoice={hostChoiceFor("history")}
            onResume={(session) => void resumeSession(session)}
            onReveal={revealOn(historyHost)}
            compact={compact}
          />
        );
      case "sessions":
        return (
          <SessionsPane
            sessions={machineSessions.sessions}
            readAtMs={machineSessions.readAtMs}
            records={sessionsById}
            resources={machineSessions.resources}
            selectedPid={selectedLivePid}
            onSelect={(session) => setSelectedLivePid(session?.pid ?? null)}
            // Bringing the terminal forward, or opening one here for a session
            // not open here, is what this pane does *to* a session, besides
            // ending one not open here: the pane is for looking, the tab is
            // for working.
            onOpenSession={openSession}
            notOpenHere={notOpen}
            onEndSession={closeSession}
            onReveal={launcher.reveal}
            compact={compact}
            remoteHosts={sessionsPaneHosts}
          />
        );
      case "config":
        return (
          <ConfigConsole
            hostChoice={hostChoiceFor("config")}
            scopes={configState.scopes}
            scopePath={configState.scopePath}
            onScopeChange={configState.setScopePath}
            view={configState.view}
            onViewChange={configState.setView}
            tree={configState.tree}
            treeLoading={configState.treeLoading}
            listError={configState.listError}
            live={configState.live}
            selected={configState.selected}
            onSelect={configState.select}
            dirty={configState.dirty}
            onRefresh={configState.refresh}
            refreshing={configState.refreshing}
            compact={compact}
            onBack={() => configState.select(null)}
            onNew={
              configState.scope === null
                ? undefined
                : () => configState.openEntryDialog("new")
            }
            notice={
              configState.deleted === null ? null : (
                <ConfigDeletedNotice
                  label={configState.deleted.label}
                  fileCount={configState.deleted.files.length}
                  busy={configState.entryBusy}
                  onUndo={configState.undoDelete}
                  onDismiss={configState.dismissDeleted}
                />
              )
            }
          >
            {configState.view === "files" ? (
              configState.selected === null ? (
                <ConfigNothingSelected
                  scope={configState.scope}
                  fileCount={configState.tree?.files.length ?? 0}
                />
              ) : (
                <ConfigEditor
                  // Keyed on the path so switching files rebuilds the editor
                  // rather than leaving one file's draft in another's box.
                  key={configState.selected.path}
                  file={configState.selected}
                  loaded={configState.loaded}
                  rendered={configState.rendered}
                  live={configState.live}
                  siblings={configState.tree?.files ?? []}
                  snapshots={configState.snapshots}
                  saving={configState.saving}
                  error={configState.editorError}
                  external={configState.external}
                  onSave={configState.save}
                  onReload={configState.reload}
                  onRestore={configState.restore}
                  onReveal={revealOn(configHost)}
                  onOpenPath={configState.openPath}
                  onOpenExternal={openLink}
                  onDirtyChange={configState.setDirty}
                  onHighlight={helmHighlight}
                  onRename={() => configState.openEntryDialog("rename")}
                  onDelete={() => configState.openEntryDialog("delete")}
                  justCreated={
                    configState.selected.path === configState.createdPath
                  }
                />
              )
            ) : configState.view === "effective" ? (
              <EffectiveViewPane
                profiles={profileState.profiles}
                profileId={configState.effectiveProfileId}
                onProfileChange={configState.setEffectiveProfileId}
                cwd={configState.effectiveCwd}
                onCwdChange={configState.setEffectiveCwd}
                view={configState.effective}
                loading={configState.effectiveLoading}
                error={configState.effectiveError}
                onReveal={revealOn(configHost)}
                onOpenFile={configState.openPath}
              />
            ) : configState.view === "mcp" ? (
              <McpPanel
                cwd={
                  configState.scope?.kind === "user"
                    ? (configState.scopes.find((s) => s.kind !== "user")
                        ?.path ?? "")
                    : (configState.scope?.path ?? "")
                }
                servers={configState.mcpServers}
                listing={configState.mcpListing}
                listing_busy={configState.mcpListing_busy}
                onList={configState.runMcpList}
                draft={configState.mcpDraft}
                onDraftChange={configState.setMcpDraft}
                preview={configState.mcpPreview}
                onPreview={configState.requestMcpPreview}
                onApply={configState.applyMcp}
                onCancelPreview={configState.cancelMcpPreview}
                applying={configState.mcpApplying}
                result={configState.mcpResult}
                onDismissResult={configState.dismissMcpResult}
                onRemove={configState.removeMcp}
                onApprove={configState.approveMcp}
                onOpenFile={configState.openPath}
              />
            ) : (
              <HealthPanel
                report={configState.doctor}
                running={configState.doctorRunning}
                onRun={configState.runDoctor}
                claudeVersion={info?.claudeVersion ?? null}
              />
            )}
          </ConfigConsole>
        );
      case "browser": {
        const view =
          frontPage === null ? undefined : browserViews.get(frontPage);
        const holder = findTab(open, paneId(ref));
        return (
          <div className="flex h-full min-h-0 flex-col">
            <BrowserPages
              pages={browsers.pages.flatMap((id) => {
                const page = browserViews.get(id);
                return page === undefined ? [] : [page];
              })}
              activeId={frontPage}
              focused={holder !== null && holder.group === open.focused}
              onActivate={browsers.activate}
              onClose={browsers.close}
              onMove={browsers.move}
              onNew={() => openBrowser({ project: null, focusAddress: true })}
            />
            {view !== undefined && (
              <div className="min-h-0 flex-1">
                <BrowserPane
                  // Keyed on the page, so switching between two pages rebuilds
                  // the bar rather than leaving one page's address in the
                  // other's box.
                  key={view.id}
                  state={view}
                  entries={browsers.entries.get(view.id) ?? EMPTY_CONSOLE}
                  recent={browsers.recent}
                  focusRequest={
                    browserFocus?.page === view.id ? browserFocus.what : null
                  }
                  onFocusRequestDone={browserFocusDone}
                  searchEngine={browserSearchName(
                    settings?.browserSearch ?? DEFAULT_SETTINGS.browserSearch,
                  )}
                  still={browsers.stills.get(view.id) ?? null}
                  canShare={settings?.browserMcp ?? DEFAULT_SETTINGS.browserMcp}
                  onShareTargets={browsers.shareTargets}
                  onShare={(session) => browsers.share(view.id, session)}
                  onBounds={(rect) => browsers.sendBounds(view.id, rect, true)}
                  onNavigate={(input) => browsers.navigate(view.id, input)}
                  onBack={() => browsers.back(view.id)}
                  onForward={() => browsers.forward(view.id)}
                  onReload={(hard) => browsers.reload(view.id, hard)}
                  onDevTools={() => browsers.devtools(view.id)}
                  onOpenExternal={(url) => void helmOpenExternal(url)}
                  onFind={(query, forward) =>
                    browsers.find(view.id, query, forward)
                  }
                  onStopFind={() => browsers.stopFind(view.id)}
                  onZoom={(level) => browsers.zoom(view.id, level)}
                  onClearStorage={() => browsers.clearStorage(view.id)}
                  onEvaluate={(source) => browsers.evaluate(view.id, source)}
                  // The address dropdown hangs over the page; the view stands
                  // down for it, the same way it does for a tab drag.
                  onCovering={(covering) =>
                    browsers.setSuppressed("address-list", covering)
                  }
                />
              </div>
            )}
          </div>
        );
      }
      case "settings":
        return renderSettings();
      case "plugin": {
        const on = hostOf(ref);
        const plugin = pluginsOn(on).get(ref.plugin);
        const surface = plugin?.tabs[ref.tab];
        const unread = pluginsUnreadOn(on);
        if (plugin === undefined && unread !== null) {
          return (
            <PluginsUnavailable reason={unread} className="absolute inset-0" />
          );
        }
        if (plugin === undefined || surface === undefined) return null;
        return (
          <PluginFrame
            spec={{
              key: pluginTabKey(ref),
              plugin: ref.plugin,
              ...(on === LOCAL_HOST_KEY ? {} : { host: on }),
              revision: plugin.revision,
              url: surface.url,
              surface: "tab",
              name: ref.tab,
              params: ref.params,
              title: ref.title ?? surface.title,
            }}
            pluginName={plugin.name}
            onOpenSettings={() => openPluginSettings(on, plugin.path)}
            className="absolute inset-0"
          />
        );
      }
      case "plugin-pages":
        return renderPluginPages(ref);
      case "restore":
        return restoreOffer === null ? null : (
          <RestorePane
            // Opened again with what a lost tab asked for ticked.
            key={restoreChosen === null ? "every" : restoreChosen.join(",")}
            {...(restoreChosen === null ? {} : { preselected: restoreChosen })}
            lostWith={LOCAL_HOST_NAME}
            offer={restoreOffer}
            withoutAsking={
              settings?.restoreWithoutAsking ??
              DEFAULT_SETTINGS.restoreWithoutAsking
            }
            onWithoutAskingChange={(restoreWithoutAsking) =>
              writeSettings({ restoreWithoutAsking })
            }
            busy={restoreState.busy}
            onResume={(ids) => void resumeLost(ids)}
            onNotNow={dismissRestore}
            now={now}
          />
        );
      case "session":
      case "terminal":
      case "file":
        // None is a page: a session or a terminal tab is its terminal and a
        // file its view, all drawn edge to edge by `renderGroup`.
        return null;
    }
  };

  /**
   * A file tab's view: the code on the pane itself, no page gutter around it -
   * or, for a note or an artifact, the document, with the code as its Source.
   */
  const renderFile = (ref: FileRef): JSX.Element => {
    const on = hostOf(ref);
    const key = fileKey(ref.path, on);
    const state = files.tabs.get(key);
    const reveal = fileReveals.get(key) ?? null;
    const code = (
      <FileView
        key={paneId(ref)}
        view={state?.view ?? null}
        error={state?.error ?? null}
        wrap={filesWrap}
        onWrapChange={setFilesWrap}
        reveal={reveal}
        onHighlight={helmHighlight}
        onCaretChange={(caret) => fileCarets.current.set(key, caret.line)}
        onReveal={revealOn(on)}
        onOpenInEditor={
          // VS Code is this PC's: a file on another host has no editor here.
          files.editor === null || on !== LOCAL_HOST_KEY
            ? null
            : () => openInEditor(ref.path, fileCarets.current.get(key) ?? null)
        }
      />
    );
    const kind = documentKind(ref.path);
    if (kind === null) return code;
    return (
      <DocumentTab
        key={paneId(ref)}
        host={on}
        scopePath={scopeOf(ref)}
        path={ref.path}
        kind={kind}
        mode={docModes.get(key) ?? "preview"}
        source={code}
        highlight={reveal?.term ?? null}
        draftKey={key}
        onDirtyChange={(dirty) => markDocDirty(key, dirty)}
        onHighlight={helmHighlight}
        // A wikilink opens beside it as a kept tab, in the same project.
        onOpenPath={(path) => openFileAt(ref.root, path, true, undefined, on)}
        onOpenExternal={openLink}
      />
    );
  };

  // ---------------------------------------------------------------------------
  // The frame
  // ---------------------------------------------------------------------------

  /**
   * The children a session tab holds in its family view, each with what it is
   * doing and for how long. Only this PC's sessions have a registry record to
   * say how long.
   */
  const kidsOf = (ref: { id: number; host?: string }): FamilyKid[] => {
    const host = ref.host ?? LOCAL_HOST_KEY;
    return (heldFamilies.get(host)?.get(ref.id) ?? []).flatMap((member) => {
      const there = sessionAt({ id: member.id, host });
      if (there === null) return [];
      return [
        {
          session: there.record,
          state: there.indicator,
          since:
            host === LOCAL_HOST_KEY
              ? (liveByHelmId.get(member.id)?.statusSinceMs ?? null)
              : null,
        },
      ];
    });
  };

  /** One pane, by its group's id: its strip, its crumb, its sessions' terminals, its front page and its drop zones. */
  const renderGroup = (id: number): JSX.Element | null => {
    const index = open.groups.findIndex((candidate) => candidate.id === id);
    const group = open.groups[index];
    if (group === undefined) return null;
    const groupFront = activeRef(group);
    const groupFrontId = groupFront === null ? null : paneId(groupFront);
    const attention = group.tabs.some(
      (ref) =>
        ref.kind === "session" && sessionAt(ref)?.indicator === "waiting",
    );
    const single = open.groups.length === 1;
    return (
      <PaneGroup
        index={index}
        id={id}
        focused={id === open.focused}
        attention={attention}
        bodyRef={(element) => {
          if (element === null) bodyRefs.current.delete(id);
          else bodyRefs.current.set(id, element);
        }}
        onFocus={() => commit((current) => focusGroup(current, id))}
        drop={
          <PaneDrop
            active={draggingTab !== null}
            allows={(zone) => dropAllows(group, zone)}
            onDrop={(tab, zone) => dropTab(tab, id, zone)}
          />
        }
        strip={
          <TabBar
            tabs={group.tabs.flatMap(tabFor)}
            activeId={groupFrontId}
            focused={id === open.focused}
            onActivate={(id) => {
              commit((current) => activateTab(current, id));
              const ref = group.tabs.find((tab) => paneId(tab) === id);
              if (ref !== undefined) bringSidebarFor(ref);
            }}
            onClose={closeAny}
            onMove={(tab, toIndex) =>
              commit((current) => moveTab(current, tab, id, toIndex))
            }
            onRename={(tab, label) => {
              const ref = sessionTabRef(tab);
              if (ref === null) return;
              if (ref.host === LOCAL_HOST_KEY)
                void sessionState.rename(ref.id, label);
              else
                void bridgeFor(ref.host)
                  .invoke("session:rename", { id: ref.id, label })
                  .then((record) => adoptThere(ref.host, record));
            }}
            onKeep={keepTab}
            menuFor={tabMenuFor}
            onMenu={onTabMenu}
            onDragging={onTabDragging}
            onNewTab={(button) => toggleNewTab(id, button)}
            newTabOpen={newTab?.group === id}
            actions={
              <>
                {groupFront?.kind === "file" && (
                  <FileActions
                    path={groupFront.path}
                    onOpenInEditor={
                      files.editor === null ||
                      hostOf(groupFront) !== LOCAL_HOST_KEY
                        ? null
                        : () =>
                            openInEditor(
                              groupFront.path,
                              fileCarets.current.get(
                                fileKey(groupFront.path),
                              ) ?? null,
                            )
                    }
                    onReveal={revealOn(hostOf(groupFront))}
                    onCopyPath={copyPath}
                  />
                )}
                <PaneActions
                  split={
                    single ? (group.tabs.length > 1 ? "new" : null) : "other"
                  }
                  maximized={shownMax === id}
                  canMaximize={group.tabs.length > 0}
                  canClose={!single}
                  onSplit={() => {
                    commit((current) => sendBeside(focusGroup(current, id)));
                    setMaximized(null);
                  }}
                  onMaximize={() => {
                    commit((current) => focusGroup(current, id));
                    setMaximized((current) => (current === id ? null : id));
                  }}
                  onClose={() => {
                    commit((current) => closeGroup(current, id));
                    setMaximized(null);
                  }}
                />
              </>
            }
          />
        }
        crumb={crumbFor(groupFront)}
      >
        {/* Every terminal in the pane stays mounted and only the front one is
            shown. The terminal itself lives in terminals.ts and outlives any
            render, but a pane that is not mounted has nowhere to put it. */}
        {group.tabs.map((ref) => {
          if (ref.kind === "terminal") {
            const isFront = groupFrontId === paneId(ref);
            return (
              <div
                key={paneId(ref)}
                className={cn("absolute inset-0", isFront ? "block" : "hidden")}
                aria-hidden={!isFront}
              >
                <TerminalTabPane
                  id={ref.id}
                  path={ref.path}
                  active={isFront}
                  windowsBuild={
                    hostOf(ref) === LOCAL_HOST_KEY
                      ? (info?.windowsBuild ?? null)
                      : null
                  }
                  {...(hostOf(ref) === LOCAL_HOST_KEY
                    ? {}
                    : { host: hostOf(ref), hostName: hostName(hostOf(ref)) })}
                />
              </div>
            );
          }
          if (ref.kind !== "session") return null;
          if (hostOf(ref) !== LOCAL_HOST_KEY) {
            const there = remoteSessionOf(hostOf(ref), ref.id);
            if (!there) return null;
            const remoteFront = groupFrontId === paneId(ref);
            // A host that dropped keeps its tab's last screen, dimmed with input
            // off under a banner; the session is still running there, and the
            // terminal reattaches once it is back.
            return (
              <FamilyTab
                key={paneId(ref)}
                tab={paneId(ref)}
                host={hostOf(ref)}
                front={remoteFront}
                own={there}
                kids={kidsOf(ref)}
                family={familyOf(open, paneId(ref))}
                now={now}
                windowsBuild={info?.windowsBuild ?? null}
                hostLost={hostAway(hostOf(ref)) ?? undefined}
                arrange={commit}
                onStop={(id) => stopChild(hostOf(ref), id)}
                parent={
                  <TerminalPane
                    session={there}
                    host={hostOf(ref)}
                    active={remoteFront}
                    windowsBuild={info?.windowsBuild ?? null}
                    onClose={(id) => closeRemoteSession(hostOf(ref), id)}
                    hostLost={hostAway(hostOf(ref)) ?? undefined}
                  />
                }
              />
            );
          }
          const session = sessionsById.get(ref.id);
          if (!session) return null;
          const isFront = groupFrontId === paneId(ref);
          return (
            <FamilyTab
              key={paneId(ref)}
              tab={paneId(ref)}
              host={LOCAL_HOST_KEY}
              front={isFront}
              own={session}
              kids={kidsOf(ref)}
              family={familyOf(open, paneId(ref))}
              now={now}
              windowsBuild={info?.windowsBuild ?? null}
              hostGone={hostLink.lost !== null}
              arrange={commit}
              onStop={(id) => stopChild(LOCAL_HOST_KEY, id)}
              parent={
                <TerminalPane
                  session={session}
                  active={isFront}
                  windowsBuild={info?.windowsBuild ?? null}
                  onClose={closeSession}
                  hostGone={hostLink.lost !== null}
                  {...(session.status === "lost"
                    ? {
                        lost: {
                          hostName: LOCAL_HOST_NAME,
                          restoreReady:
                            hostLink.lost === null &&
                            (restoreOffer?.sessions.some(
                              (each) =>
                                each.id === session.id &&
                                each.blocked === null,
                            ) ??
                              false),
                          onRestore: () => restoreSession(session.id),
                        },
                      }
                    : {})}
                />
              }
            />
          );
        })}
        {groupFront?.kind === "file" && (
          <div className="absolute inset-0">{renderFile(groupFront)}</div>
        )}
        {groupFront !== null &&
          groupFront.kind !== "session" &&
          groupFront.kind !== "terminal" &&
          groupFront.kind !== "file" && (
            // On the pane itself: the pane is the island, and a page says what it
            // has in sections with hairlines rather than islands of its own.
            <div className="absolute inset-0">
              {renderPage(groupFront, narrow.has(id))}
            </div>
          )}
      </PaneGroup>
    );
  };

  // A fact about the machine that qualifies the whole window: the CLI is
  // missing, or it is a version outside what this build was measured against.
  const versionWarning =
    setup.status !== null &&
    !setup.bannerDismissed &&
    (setup.status.path === null ||
      setup.status.version === null ||
      !setup.status.tested);

  const toggleView = (view: SidebarView): void => {
    if (sidebarShown && sidebarView === view) {
      setSidebarHidden(true);
      return;
    }
    setSidebarView(view);
    setSidebarHidden(false);
    setMaximized(null);
  };

  /** A plugin's rail panel, brought up - never put away, as pressing its icon again would. */
  const showPluginPanel = (id: string): void => {
    setSidebarView(pluginRailId(id));
    setSidebarHidden(false);
    setMaximized(null);
  };

  /**
   * Every plugin with a rail icon: this PC's, then each connected host's in
   * the order the hosts were added, each by the sidebar view it opens.
   */
  const railPluginEntries = [LOCAL_HOST_KEY, ...connectedHostIds].flatMap(
    (host) =>
      [...pluginsOn(host).entries()].flatMap(([id, plugin]) =>
        plugin.rail === null
          ? []
          : [
              {
                host,
                id,
                plugin,
                rail: plugin.rail,
                view: railViewOf(host, id),
              },
            ],
      ),
  );

  /** The plugin panel the sidebar is showing, when it is showing one, on its host. */
  const sidebarPanel = (() => {
    if (!sidebarView.startsWith("plugin:")) return null;
    const entry = railPluginEntries.find(
      (candidate) => candidate.view === sidebarView,
    );
    if (entry === undefined) return null;
    const { host, id, plugin } = entry;
    const spec = railPanelSpec(id, plugin, host);
    if (spec === null) return null;
    return {
      spec,
      host,
      name: plugin.name,
      path: plugin.path,
      actions: plugin.panels[spec.name]?.actions ?? [],
    };
  })();

  /** Each plugin's status item; pressing one opens its panel, or its Settings page when it has none. */
  const statusPlugins: StatusPluginItem[] = [...plugins.entries()].flatMap(
    ([id, plugin]) =>
      plugin.status === null
        ? []
        : [
            {
              id,
              name: plugin.name,
              text: plugin.status.text,
              tone: plugin.status.tone ?? "neutral",
              tooltip: plugin.status.tooltip ?? null,
              onSelect: () =>
                plugin.rail !== null
                  ? showPluginPanel(id)
                  : openSettings(pluginSection(plugin.path)),
            },
          ],
  );

  const paletteCommands: PaletteCommand[] = [...plugins.entries()].flatMap(
    ([id, plugin]) =>
      plugin.commands.map((command) => ({
        key: `${id}/${command.id}`,
        title: command.title,
        source: plugin.name,
        icon: <PluginIcon url={plugin.icon} size={13} />,
      })),
  );

  /**
   * A command chosen in the palette. One with a tab opens it; one without is
   * an event for the plugin's background page when it has one, and otherwise
   * for its rail panel, which comes up to take it.
   */
  const runPluginCommand = (key: string): void => {
    setPaletteOpen(false);
    const slash = key.indexOf("/");
    const id = key.slice(0, slash);
    const plugin = plugins.get(id);
    const command = plugin?.commands.find(
      (candidate) => candidate.id === key.slice(slash + 1),
    );
    if (plugin === undefined || command === undefined) return;
    if (command.tab !== null) {
      openPluginTab(id, command.tab, {}, null, false);
      return;
    }
    if (plugin.background !== null) {
      void helm.invoke("plugins:command", { plugin: id, id: command.id });
      return;
    }
    const spec = railPanelSpec(id, plugin);
    if (spec === null) return;
    showPluginPanel(id);
    queueToPluginFrame(spec, "command", { id: command.id });
  };

  /** The plugins a secret asked for may be shared with: those on the asking plugin's host. */
  const secretChoices: SecretPluginChoice[] = [
    ...pluginsOn(secretAsk?.host ?? LOCAL_HOST_KEY).entries(),
  ].map(([id, plugin]) => ({
    id,
    name: plugin.name,
    network: plugin.network,
    secrets: plugin.secrets.map((entry) => entry.key),
  }));

  const inFront = (...kinds: PaneRef["kind"][]): boolean =>
    front !== null && kinds.includes(front.kind);
  const page = (
    id: string,
    label: string,
    icon: JSX.Element,
    onSelect: () => void,
    current: boolean,
    hook: `data-${string}`,
  ): RailItem => ({
    id,
    label,
    icon,
    kind: "page",
    current,
    onSelect,
    hooks: { [hook]: true } as Record<`data-${string}`, boolean>,
  });

  const railHidden = settings?.railHidden ?? DEFAULT_SETTINGS.railHidden;
  /** A tick in the rail's right-click menu: hidden, or back where it was. */
  const toggleRailItem = (id: string): void => {
    const known: RailItemId | undefined =
      RAIL_DESTINATIONS.find((destination) => destination === id) ??
      (isPluginRailId(id) ? id : undefined);
    if (known === undefined) return;
    const hiding = !railHidden.includes(known);
    writeSettings({
      railHidden: hiding
        ? [...railHidden, known]
        : railHidden.filter((item) => item !== known),
    });
    // Hiding the view the sidebar is showing puts the sidebar away with it.
    if (hiding && sidebarShown && sidebarView === known) setSidebarHidden(true);
  };

  // Plugins with a rail icon, in a group of their own under a rule: each opens
  // its panel in the sidebar, the way Sessions and Files do.
  // Another host's say which host in their hover text.
  const pluginRailItems = railPluginEntries.map(
    ({ host, id, plugin, rail, view }): RailItem => ({
      id: view,
      label:
        host === LOCAL_HOST_KEY
          ? rail.title
          : `${rail.title} · ${hostName(host)}`,
      icon: <PluginIcon url={plugin.icon} size={RAIL_ICON.width} />,
      kind: "view",
      current: sidebarShown && sidebarView === view,
      badge: plugin.badge,
      onSelect: () => toggleView(view),
      hooks:
        host === LOCAL_HOST_KEY
          ? { "data-open-plugin": id }
          : { "data-open-plugin": id, "data-plugin-host": host },
    }),
  );
  const railPlugins = pluginRailItems.length === 0 ? [] : [pluginRailItems];

  // Ordered by how often each is reached for (DESIGN.md "The rail"): the
  // daily three - sessions, profiles and history - then the rest under a rule.
  const rail = (
    <Rail
      hidden={new Set<string>(railHidden)}
      onToggleHidden={toggleRailItem}
      groups={[
        [
          {
            id: "sessions",
            label: "Sessions",
            icon: <TerminalIcon {...RAIL_ICON} />,
            kind: "view",
            current: sidebarShown && sidebarView === "sessions",
            attention: statusCounts.waiting > 0,
            onSelect: () => toggleView("sessions"),
          },
          {
            id: "profiles",
            label: "Profiles",
            icon: <LayersIcon {...RAIL_ICON} />,
            kind: "view",
            current: sidebarShown && sidebarView === "profiles",
            onSelect: () => toggleView("profiles"),
            hooks: { "data-open-profiles": true },
          },
          page(
            "history",
            "Session history",
            <HistoryIcon {...RAIL_ICON} />,
            openHistory,
            inFront("history"),
            "data-open-history",
          ),
        ],
        [
          {
            id: "files",
            label: "Files",
            icon: <DocIcon {...RAIL_ICON} />,
            kind: "view",
            current: sidebarShown && sidebarView === "files",
            onSelect: () => toggleView("files"),
            hooks: { "data-open-files": true },
          },
          page(
            "browser",
            "Browser",
            <GlobeIcon {...RAIL_ICON} />,
            showBrowser,
            inFront("browser"),
            "data-open-browser",
          ),
          page(
            "config",
            "Config",
            <SlidersIcon {...RAIL_ICON} />,
            openConfig,
            inFront("config"),
            "data-open-config",
          ),
        ],
        ...railPlugins,
      ]}
      footer={[
        {
          id: "settings",
          label: "Settings",
          icon: <GearIcon {...RAIL_ICON} />,
          kind: "view",
          // A view, because its sections are: the sidebar lists them and the
          // pane shows the one picked. Pressed again it puts the sidebar away
          // and leaves the page open, as every view does.
          current: sidebarShown && sidebarView === "settings",
          hideable: false,
          onSelect: () =>
            sidebarShown && sidebarView === "settings"
              ? setSidebarHidden(true)
              : openSettings(),
          hooks: { "data-open-settings": true },
        },
      ]}
    />
  );

  const sidebar = !sidebarShown ? null : (
    <>
      <div
        className={cn("flex h-full", sidebarView !== "sessions" && "hidden")}
      >
        <Sidebar
          title="Sessions"
          actions={
            <>
              <SidebarAction
                label={`New session (${shortcutLabel("N")})`}
                onClick={openLauncher}
                data-new-session
              >
                <PlusIcon width={13} height={13} />
              </SidebarAction>
              <SidebarAction
                label="Rescan all folders"
                onClick={launcher.rescan}
                disabled={launcher.scanning}
              >
                <RefreshIcon
                  width={13}
                  height={13}
                  className={cn(launcher.scanning && "animate-spin")}
                />
              </SidebarAction>
              <SidebarAction
                label="Create a new harness"
                onClick={() => setup.openDialog("new")}
                data-create-harness
              >
                <HarnessIcon width={13} height={13} />
              </SidebarAction>
              <SidebarAction
                label="Add a folder to scan"
                onClick={launcher.addRoot}
                data-add-root
              >
                <FolderPlusIcon width={13} height={13} />
              </SidebarAction>
            </>
          }
          footer={
            <button
              type="button"
              data-open-sessions
              onClick={openSessions}
              title="Every Claude Code session running on this machine"
              aria-current={inFront("sessions") ? "true" : undefined}
              className={cn(
                "flex h-7 w-full items-center gap-2 rounded-raised px-2 text-left text-[11.5px] transition-colors",
                inFront("sessions")
                  ? "bg-hover text-fg hover:bg-active"
                  : "text-fg-subtle hover:bg-hover hover:text-fg",
              )}
            >
              <TerminalIcon width={12} height={12} className="shrink-0" />
              <span className="min-w-0 truncate">{sessionsSummaryLine}</span>
            </button>
          }
        >
          <SessionTree
            discovery={discovery}
            scanning={launcher.scanning}
            scanError={launcher.scanError}
            selectedPath={front?.kind === "project" ? front.path : null}
            pinnedPaths={
              settings?.pinnedProjects ?? DEFAULT_SETTINGS.pinnedProjects
            }
            onTogglePin={togglePin}
            sessionsByPath={tree.byPath}
            elsewhere={tree.elsewhere}
            onSelect={openProject}
            onLaunch={(project) => void launch(project)}
            launchingPath={launchingPath}
            onOpenSession={openTreeSession}
            onAddRoot={launcher.addRoot}
            reveal={treeReveal}
            hostActions={treeHostActions}
            localName={LOCAL_HOST_LABEL}
            localKey={LOCAL_HOST_KEY}
            {...sessionTreeHostProps({
              hosts: treeHosts,
              onAddHost: () => setAddingHost(true),
            })}
          />
        </Sidebar>
      </div>
      {/* The tree stays mounted while it is out of sight, so what is folded and
          what the filter holds survive a look at the profiles. The profile list
          is mounted only while it is the view: its rows are titled buttons
          inside the sidebar, and kept hidden in the DOM they would be counted
          by every `aside button[title]` that means "a project row". */}
      {sidebarView === "files" && (
        <Sidebar
          title="Files"
          scope={
            <FilesRootPicker
              roots={files.roots}
              value={files.root}
              onChange={files.setRoot}
              hostChoice={hostChoiceFor("files")}
            />
          }
          actions={
            files.root === null ? undefined : (
              <>
                {files.host === LOCAL_HOST_KEY && (
                  <SidebarAction
                    label="Reveal project in Explorer"
                    onClick={() => {
                      if (files.root !== null) launcher.reveal(files.root);
                    }}
                  >
                    <FolderIcon width={13} height={13} />
                  </SidebarAction>
                )}
                {files.editor !== null && files.host === LOCAL_HOST_KEY && (
                  <SidebarAction
                    label="Open project in VS Code"
                    onClick={() => {
                      if (files.root !== null) openInEditor(files.root, null);
                    }}
                  >
                    <CodeIcon width={13} height={13} />
                  </SidebarAction>
                )}
              </>
            )
          }
          footer={
            files.status !== null &&
            (files.status.repo === null || files.status.files === null) ? (
              <FilesStatusNote status={files.status} />
            ) : undefined
          }
        >
          {files.rootsError !== null && (
            <p
              data-files-roots-error
              role="alert"
              className="px-3.5 py-2 text-[12px] text-danger"
            >
              {files.rootsError}
            </p>
          )}
          {files.root === null ? (
            files.rootsError === null && (
              <p className="px-3.5 py-6 text-[12px] text-fg-subtle">
                Choose a project above to see its files.
              </p>
            )
          ) : (
            <FilesTree
              rootLabel={folderName(files.root)}
              dirs={files.dirs}
              expanded={files.expanded}
              loading={files.loadingDirs}
              status={files.status}
              selectedPath={
                front?.kind === "file" && hostOf(front) === files.host
                  ? front.path
                  : null
              }
              {...(filesRevealSeq === undefined
                ? {}
                : { revealSeq: filesRevealSeq })}
              onToggleDir={files.toggleDir}
              onOpen={(path, keep) => {
                if (files.root !== null)
                  openFileAt(files.root, path, keep, undefined, files.host);
              }}
              onReveal={revealOn(files.host)}
              onCopyPath={copyPath}
              onOpenInEditor={
                files.editor === null || files.host !== LOCAL_HOST_KEY
                  ? null
                  : (path) => openInEditor(path, null)
              }
              onGoToFile={openQuickOpen}
            />
          )}
        </Sidebar>
      )}
      {sidebarView === "settings" && (
        <Sidebar title="Settings">
          <SettingsSections
            current={settingsSection}
            plugins={(pluginState.list ?? []).map((plugin) => ({
              path: plugin.path,
              name: plugin.name,
              state: !plugin.enabled
                ? "off"
                : plugin.error !== null
                  ? "error"
                  : "on",
            }))}
            onSelect={(section) => {
              setSettingsSection(section);
              openPane({ kind: "settings" });
            }}
          />
        </Sidebar>
      )}
      {sidebarView === "profiles" && (
        <Sidebar
          title="Profiles"
          actions={
            <>
              <SidebarAction
                label="Import a profile"
                onClick={() => void profileState.importProfile()}
              >
                <ImportIcon width={13} height={13} />
              </SidebarAction>
              <SidebarAction
                label="New profile"
                onClick={() => {
                  setSaveProblems([]);
                  setEditing(blankProfile(discovery?.roots[0] ?? "", ""));
                }}
              >
                <PlusIcon width={13} height={13} />
              </SidebarAction>
            </>
          }
        >
          <ProfileList
            profiles={profileState.profiles}
            harnesses={discovery?.harnesses ?? []}
            launchingIds={profileState.launching}
            onLaunch={(profile) => void launchProfile(profile)}
            onEdit={(profile) => {
              setSaveProblems([]);
              setEditing(profile);
            }}
            onDelete={deleteProfile}
            onExport={(profile) => void profileState.exportProfile(profile.id)}
            onTogglePin={(profile) => void profileState.togglePin(profile)}
            onReorder={(ids) => void profileState.reorder(ids)}
            {...(listedHosts.length === 0
              ? {}
              : {
                  host: {
                    id: LOCAL_HOST_KEY,
                    name: LOCAL_HOST_LABEL,
                    remote: false,
                    connected: true,
                    onNew: () => {
                      setSaveProblems([]);
                      setEditing(blankProfile(discovery?.roots[0] ?? "", ""));
                    },
                  },
                })}
          />
          {listedHosts.map((host) => {
            const scanned = hostWork.byHost.get(host.id)?.discovery ?? null;
            return (
              <HostProfiles
                key={host.id}
                host={host.id}
                name={host.name}
                request={
                  profileRequest?.host === host.id ? profileRequest : null
                }
                connected={connectedHostIds.includes(host.id)}
                projects={scanned?.projects ?? EMPTY_PROJECTS}
                harnesses={scanned?.harnesses ?? []}
                blank={blankProfile}
                paneSize={() => bodyRefs.current.get(open.focused) ?? null}
                onLaunched={(record) => {
                  adoptThere(host.id, record);
                  placeSession(record.id, false, undefined, host.id);
                }}
              />
            );
          })}
        </Sidebar>
      )}
      {sidebarPanel === null &&
        sidebarView.startsWith("plugin:") &&
        pluginState.error !== null && (
          <Sidebar title="Plugin">
            <PluginsUnavailable
              reason={pluginState.error}
              className="min-h-0 flex-1"
            />
          </Sidebar>
        )}
      {sidebarPanel !== null && (
        <Sidebar
          title={sidebarPanel.spec.title}
          actions={
            sidebarPanel.actions.length === 0 ? undefined : (
              <>
                {sidebarPanel.actions.map((action) => {
                  const Glyph = PANEL_ACTION_ICON[action.icon];
                  return (
                    <SidebarAction
                      key={action.id}
                      label={action.title}
                      onClick={() =>
                        emitToPluginFrame(sidebarPanel.spec.key, "action", {
                          id: action.id,
                        })
                      }
                    >
                      <Glyph width={13} height={13} />
                    </SidebarAction>
                  );
                })}
              </>
            )
          }
        >
          <PluginFrame
            spec={sidebarPanel.spec}
            pluginName={sidebarPanel.name}
            onOpenSettings={() =>
              openPluginSettings(sidebarPanel.host, sidebarPanel.path)
            }
            className="min-h-0 flex-1"
          />
        </Sidebar>
      )}
    </>
  );

  const empty = open.groups.length === 1 && open.groups[0]!.tabs.length === 0;

  /**
   * One line over the panes, for what a launch composed and anything that went
   * wrong doing it, first failure first. A launcher error is said in the
   * launcher while it is open; this is for a launch with nowhere else to say it
   * - a new harness's first session, a profile from the sidebar.
   */
  const treeLaunch: TreeLaunchFailure | null =
    remoteLaunchError ??
    (sessionState.launchError !== null && localLaunch !== null
      ? { host: LOCAL_HOST_KEY, ...localLaunch, text: sessionState.launchError }
      : null);
  const frontGroup = groupById(open, open.focused);
  const treeNotice = treeLaunchNotice(
    treeLaunch,
    frontGroup === undefined ? null : activeRef(frontGroup),
    hostName,
  );
  const dismissTreeLaunch = (): void => {
    setRemoteLaunchError(null);
    sessionState.dismissLaunchError();
  };
  const toast: { text: string; failed: boolean; dismiss: () => void } | null =
    browsers.error !== null
      ? { text: browsers.error, failed: true, dismiss: browsers.dismissError }
      : stopHostError !== null
        ? {
            text: stopHostError,
            failed: true,
            dismiss: () => setStopHostError(null),
          }
        : !newSession.open && newTab === null && newSession.error !== null
          ? {
              text: newSession.error,
              failed: true,
              dismiss: newSession.dismissError,
            }
          : treeNotice !== null
            ? { text: treeNotice, failed: true, dismiss: dismissTreeLaunch }
            : restoreState.report !== null
              ? { ...restoreState.report, dismiss: restoreState.dismissReport }
              : profileState.error !== null
                ? {
                    text: profileState.error,
                    failed: true,
                    dismiss: profileState.dismissError,
                  }
                : newSession.warning !== null
                  ? {
                      text: newSession.warning,
                      failed: false,
                      dismiss: newSession.dismissWarning,
                    }
                  : profileState.notice !== null
                    ? {
                        text: profileState.notice,
                        failed: false,
                        dismiss: profileState.dismissNotice,
                      }
                    : null;

  return (
    <AppShell
      rail={rail}
      sidebar={sidebar}
      banner={
        <>
          {versionWarning && setup.status ? (
            <VersionBanner
              version={setup.status.version}
              range={setup.status.testedRange}
              error={setup.status.error}
              onDismiss={setup.dismissBanner}
              onLocate={setup.locateClaude}
            />
          ) : null}
          {ownData.unfinished !== null ? (
            <OwnDataBanner
              reason={ownData.unfinished}
              onDismiss={ownData.dismiss}
            />
          ) : null}
          {hostLink.lost !== null ? (
            <HostStoppedBanner
              hostName={LOCAL_HOST_NAME}
              restarting={hostLink.lost.restarts}
            />
          ) : null}
        </>
      }
      statusBar={
        <StatusBar
          sessions={statusCounts}
          onShowWaiting={showWaiting}
          mode={info === null ? null : MODE_LABEL[info.mode]}
          version={info?.version ?? null}
          // From the setup status before `app:info`, which is read once at
          // startup: after the CLI is relocated the strip would go on naming the
          // old version while Settings names the new one.
          claudeVersion={
            setup.status?.semver ??
            setup.status?.version ??
            info?.claudeVersion ??
            null
          }
          // From the setup status, not from `app:info`, which is read once at
          // startup: after the CLI is relocated the strip would go on saying it
          // is missing while the banner above it says it was found.
          claudeMissing={setup.status !== null && setup.status.path === null}
          usage={usage.snapshot}
          usageError={usage.error}
          usageHostChoice={hostChoiceFor("usage")}
          usageDisplay={settings?.usageDisplay ?? "percent"}
          onUsageDisplayChange={launcher.setUsageDisplay}
          update={update}
          onOpenUpdate={(url) => void helmOpenExternal(url)}
          plugins={statusPlugins}
          // With sessions in this PC's host: each host, where they run and what
          // quitting does there, which opens the setting that decides.
          hosts={statusHosts}
        />
      }
    >
      <div className="relative h-full w-full">
        {empty ? (
          <div className="h-full w-full">
            <WelcomePane
              roots={settings?.scanRoots ?? []}
              projectCount={discovery?.projects.length ?? 0}
              onAddRoot={launcher.addRoot}
              onCreateHarness={() => setup.openDialog("new")}
              onNewSession={openLauncher}
            />
          </div>
        ) : (
          <PaneGrid
            root={open.root}
            maximized={shownMax}
            gap={settings?.paneGap ?? DEFAULT_SETTINGS.paneGap}
            panes={new Map(shownGroups.map((id) => [id, renderGroup(id)]))}
            onResize={(path, sizes) =>
              commit((current) => resizeSplit(current, path, sizes))
            }
            onResizing={onPaneResizing}
          />
        )}

        {harnessDialog}
        {templateDialogs}
        {confirmDialog}
        {restartDialog}
        {configEntryDialog}
        {addingHost && (
          <AddHostDialog
            actions={addHostActions}
            hosts={currentSettings.hosts}
            // Written at once for the new host: the status bar says it.
            onQuitChange={(id, choice) =>
              writeSettings({
                quitSessions: {
                  ...currentSettings.quitSessions,
                  [id]: choice,
                },
              })
            }
            onClose={() => setAddingHost(false)}
          />
        )}
        {quickOpenRoot !== null && (
          <QuickOpenDialog
            rootLabel={
              files.roots.find(
                (scope) =>
                  scope.path.toLowerCase() === quickOpenRoot.toLowerCase(),
              )?.label ?? folderName(quickOpenRoot)
            }
            listing={files.listing}
            recent={files.recentIn(quickOpenRoot)}
            initialMode={quickOpenMode}
            onSearchText={searchText}
            onOpen={(relPath, at) => {
              setQuickOpenRoot(null);
              openFileAt(
                quickOpenRoot,
                joinRoot(quickOpenRoot, relPath),
                true,
                at,
                files.host,
              );
            }}
            onDismiss={() => setQuickOpenRoot(null)}
          />
        )}
        {paletteOpen && (
          <CommandPalette
            commands={paletteCommands}
            onRun={runPluginCommand}
            onDismiss={() => setPaletteOpen(false)}
          />
        )}
        {frontSessionAsk !== null && (
          <PluginSessionDialog
            key={frontSessionAsk.requestId}
            pluginName={
              pluginsOn(frontSessionAsk.host).get(frontSessionAsk.plugin)
                ?.name ?? frontSessionAsk.plugin
            }
            cwd={frontSessionAsk.cwd}
            name={frontSessionAsk.name}
            prompt={frontSessionAsk.prompt}
            busy={sessionAskState.busy}
            error={sessionAskState.error}
            onStart={() => void answerSessionAsk(true)}
            onCancel={() => void answerSessionAsk(false)}
          />
        )}
        {secretAsk !== null && (
          <SecretDialog
            key={secretAsk.requestId}
            existing={
              askSecrets.secrets?.secrets.find(
                (entry) => entry.key === secretAsk.key,
              ) ?? null
            }
            presetKey={secretAsk.key}
            requester={{
              id: secretAsk.plugin,
              name:
                pluginsOn(secretAsk.host).get(secretAsk.plugin)?.name ??
                secretAsk.plugin,
            }}
            plugins={secretChoices}
            available={askSecrets.secrets?.available ?? true}
            onSave={askSecrets.saveSecret}
            onClose={() => {
              bridgeFor(secretAsk.host).send("plugins:answer", {
                requestId: secretAsk.requestId,
              });
              setSecretAsks((current) => current.slice(1));
            }}
          />
        )}
        {newSession.open && (
          <NewSessionDialog
            // A host switched to is a new list of folders and profiles.
            key={newSession.host}
            {...(launcherHosts.length > 1
              ? {
                  hosts: launcherHosts,
                  host: newSession.host,
                  onHostChange: newSession.setHost,
                }
              : {})}
            projects={
              newSession.host === LOCAL_HOST_KEY
                ? (discovery?.projects ?? EMPTY_PROJECTS)
                : (hostWork.byHost.get(newSession.host)?.discovery?.projects ??
                  EMPTY_PROJECTS)
            }
            recency={newSession.recency}
            live={
              newSession.host === LOCAL_HOST_KEY
                ? machineSessions.sessions
                : EMPTY_LIVE
            }
            profiles={
              newSession.host === LOCAL_HOST_KEY
                ? profileState.profiles
                : launcherProfiles.profiles
            }
            home={info?.home ?? null}
            initialPath={newSession.initialPath}
            resumable={newSession.resumable}
            onShowing={newSession.loadResumable}
            busy={newSession.busy}
            error={newSession.error}
            now={now}
            onStart={(choice) => void startChosen(choice)}
            onTerminal={(project, beside) => {
              openTerminal(project.path, beside);
              newSession.hide();
            }}
            onDismiss={newSession.hide}
          />
        )}
        {newTab !== null && groupById(open, newTab.group) !== undefined && (
          <NewTabMenu
            // A new `+` is a new menu, from its first step.
            key={newTab.group}
            anchor={newTab.anchor}
            {...(launcherHosts.length > 1
              ? {
                  hosts: launcherHosts,
                  host: newTab.host,
                  onHostChange: (next: string) => {
                    newSession.setHost(next);
                    setNewTab((current) =>
                      current === null
                        ? current
                        : { ...current, host: next, folder: null },
                    );
                  },
                }
              : {})}
            projects={
              newTab.host === LOCAL_HOST_KEY
                ? (discovery?.projects ?? EMPTY_PROJECTS)
                : (hostWork.byHost.get(newTab.host)?.discovery?.projects ??
                  EMPTY_PROJECTS)
            }
            recency={newSession.recency}
            live={
              newTab.host === LOCAL_HOST_KEY
                ? machineSessions.sessions
                : EMPTY_LIVE
            }
            profiles={
              newTab.host === LOCAL_HOST_KEY
                ? profileState.profiles
                : launcherProfiles.profiles
            }
            home={info?.home ?? null}
            initialPath={newTab.folder}
            resumable={newSession.resumable}
            onShowing={newSession.loadResumable}
            busy={newSession.busy}
            error={newSession.error}
            now={now}
            onStart={(choice) => void startChosen(choice, newTab.group)}
            onProfile={(profile) =>
              void launchProfileOn(newTab.host, profile, newTab.group)
            }
            onBrowser={() =>
              openBrowser({
                project: null,
                into: newTab.group,
                focusAddress: true,
              })
            }
            onTerminal={(project) => {
              openTerminal(project.path, false, newTab.group, newTab.host);
              setNewTab(null);
            }}
            onDismiss={closeNewTab}
          />
        )}

        {/* What a launch composed, and anything that went wrong doing it. Over
            the panes rather than in one, because a profile is launched from the
            sidebar and whatever is on screen at the time is unrelated - and at
            the top, because a hosted TUI's composer lives along the bottom.

            A browser refusal that produced no tab shares it: there is no pane
            to say it in. Anything that *did* produce a tab says so on that
            tab's own problem line instead. */}
        {toast !== null && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center p-3">
            {/* Two elements for one island, and the outer one is the fix:
                `bg-danger/10` is a *tint*, and a tint over a transparent
                container is a tint over whatever is behind it - the tab strip,
                here. An opaque ground with the tint composited onto it. */}
            <div className="pointer-events-auto max-w-2xl overflow-hidden rounded-raised bg-surface shadow-panel">
              <div
                role="status"
                className={cn(
                  "flex items-start gap-3 rounded-raised border px-3 py-2 text-[12px]",
                  toast.failed
                    ? "border-danger/30 bg-danger/10 text-danger"
                    : "border-border text-fg-muted",
                )}
              >
                <span className="min-w-0">{toast.text}</span>
                <button
                  type="button"
                  onClick={toast.dismiss}
                  aria-label="Dismiss"
                  className="shrink-0 text-fg-subtle hover:text-fg"
                >
                  ×
                </button>
              </div>
            </div>
          </div>
        )}

        {editing !== null && (
          <ProfileEditor
            initial={editing}
            projects={discovery?.projects ?? []}
            predict={predictProfile}
            problems={saveProblems}
            saving={saving}
            onSave={(draft) => void saveProfile(draft)}
            onCancel={() => setEditing(null)}
            // Only for a profile that exists. The editor closes because the row
            // it edits is gone.
            {...("id" in editing
              ? {
                  onDelete: () => {
                    deleteProfile(editing);
                    setEditing(null);
                  },
                }
              : {})}
          />
        )}
      </div>
    </AppShell>
  );
}
