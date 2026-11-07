export { AppShell, type AppShellProps } from './components/AppShell'
export {
  BrowserPane,
  BROWSER_WIDTHS,
  BROWSER_ZOOM,
  type BrowserPaneProps,
  type BrowserPaneState,
  type BrowserShareTarget
} from './components/BrowserPane'
export { Chip, type ChipProps, type ChipTone } from './components/Chip'
export { EmptyState, type EmptyStateProps } from './components/EmptyState'
export { CommandPalette, commandScore, type CommandPaletteProps, type PaletteCommand } from './components/CommandPalette'
export { PluginIcon } from './components/PluginIcon'
export {
  PluginPage,
  PluginsPage,
  type PluginPageProps,
  type PluginsPageProps
} from './components/PluginSettings'
export {
  PluginSessionDialog,
  pluginSessionCommand,
  type PluginSessionDialogProps
} from './components/PluginSessionDialog'
export {
  SecretDialog,
  SecretsPage,
  type SecretDialogProps,
  type SecretPluginChoice,
  type SecretsPageProps
} from './components/SecretsSettings'
export {
  ConsolePanel,
  type ConsoleEntry,
  type ConsoleFilter,
  type ConsolePanelProps
} from './components/ConsolePanel'
export {
  ConfigConsole,
  ConfigNothingSelected,
  type ConfigConsoleProps,
  type ConfigViewKind
} from './components/ConfigConsole'
export {
  CodeEditor,
  type CodeEditorHandle,
  type CodeEditorProps,
  type EditorStatus
} from './components/CodeEditor'
export { ConfigEditor, type ConfigEditorProps } from './components/ConfigEditor'
export {
  ConfigDeleteDialog,
  ConfigDeletedNotice,
  ConfigNewDialog,
  ConfigRenameDialog,
  type ConfigDeleteDialogProps,
  type ConfigDeletedNoticeProps,
  type ConfigNewDialogProps,
  type ConfigRenameDialogProps
} from './components/ConfigFileDialogs'
export { FilesRootPicker, FilesStatusNote, FilesTree, type FilesTreeProps } from './components/FilesTree'
export { FileActions, FileCrumb, FileView, type FileViewProps } from './components/FileView'
export {
  QuickOpenDialog,
  type QuickOpenAt,
  type QuickOpenDialogProps,
  type QuickOpenMode
} from './components/QuickOpenDialog'
export {
  ContentDocumentPane,
  type ArtifactConsoleEntry,
  type ContentDocumentPaneProps,
  type ContentMode
} from './components/ContentDocumentPane'
export {
  EffectiveViewPane,
  type EffectiveViewPaneProps
} from './components/EffectiveViewPane'
export { HealthPanel, type HealthPanelProps } from './components/HealthPanel'
export { McpPanel, type McpPanelProps } from './components/McpPanel'
export { NewHarnessDialog, type NewHarnessDialogProps } from './components/NewHarnessDialog'
export {
  NewSessionDialog,
  type LaunchChoice,
  type LauncherHost,
  type NewSessionDialogProps
} from './components/NewSessionDialog'
export { NewTabMenu, type NewTabMenuProps } from './components/NewTabMenu'
export {
  SaveAsTemplateDialog,
  type SaveAsTemplateDialogProps
} from './components/SaveAsTemplateDialog'
export { TemplateManager, type TemplateManagerProps } from './components/TemplateManager'
export { Overlay, type OverlayProps } from './components/Overlay'
export { Menu, type MenuAnchor, type MenuEntry, type MenuProps } from './components/Menu'
export {
  ConfirmSessionDialog,
  type ConfirmSessionDialogProps
} from './components/ConfirmSessionDialog'
export {
  SetupPane,
  type SetupClaudeStatus,
  type SetupPaneProps
} from './components/SetupPane'
export {
  SettingsPane,
  updateOutcome,
  type AgentLimitSettings,
  type SettingsPaneProps,
  type TerminalSettings,
  type UpdateCheckResult,
  type UpdateOutcome,
  type UpdateOutcomeState
} from './components/SettingsPane'
export {
  SETTINGS_SECTIONS,
  SettingsSections,
  pluginSection,
  type SettingsPluginLink,
  type SettingsSection,
  type SettingsSectionId,
  type SettingsSectionsProps
} from './components/SettingsSections'
export { AddHostDialog, type AddHostActions, type AddHostDialogProps } from './components/AddHostDialog'
export {
  HostsSettings,
  type HostInstallActions,
  type HostsSettingsProps,
  type SettingsHost
} from './components/HostsSettings'
export {
  DevicesSettings,
  type DevicesSettingsProps,
  type SettingsAttachedDevice,
  type SettingsDevicesHost
} from './components/DevicesSettings'
export { VersionBanner, type VersionBannerProps } from './components/VersionBanner'
export { OwnDataBanner, type OwnDataBannerProps } from './components/OwnDataBanner'
export { HostLostBanner, type HostLostBannerProps } from './components/HostLostBanner'
export { HostStoppedBanner, type HostStoppedBannerProps } from './components/HostStoppedBanner'
export { HostSwitch, type HostChoice, type HostSwitchProps } from './components/HostSwitch'
export { ShellLostBar, type ShellLostBarProps } from './components/ShellLostBar'
export { GitChip, type GitChipProps } from './components/GitChip'
export { InventoryChips, type InventoryChipsProps } from './components/InventoryChips'
export {
  ProfileEditor,
  type ProfileEditorProps,
  type ProfilePrediction
} from './components/ProfileEditor'
export { ProfileList, type ProfileListHost, type ProfileListProps } from './components/ProfileList'
export { ProjectPane, type ProjectPaneProps } from './components/ProjectPane'
export {
  ProjectRow,
  SessionRow,
  type ProjectRowProps,
  type SessionRowProps
} from './components/ProjectRow'
export {
  PaneActions,
  PaneCrumb,
  PaneGroup,
  paneName,
  type CrumbParent,
  type CrumbTag,
  type CrumbTone,
  type PaneCrumbProps,
  type PaneGroupProps
} from './components/PaneGroup'
export {
  ChildHeader,
  FAMILY_HEADER_PX,
  FamilyCard,
  FamilyFrame,
  FamilyKids,
  ReportNote,
  type ChildHeaderProps,
  type ChildHeaderShape,
  type FamilyFrameProps,
  type FamilyKidsProps,
  type ReportNoteProps
} from './components/FamilyView'
export { PaneDrop, type PaneDropProps } from './components/PaneDrop'
export { PaneGrid, type PaneGridProps } from './components/PaneGrid'
export {
  PANE_MIN_HEIGHT,
  PANE_MIN_WIDTH,
  PANES_MOVED_EVENT,
  type PaneDropZone
} from './lib/paneGeometry'
export { Rail, RAIL_ICON, type RailItem, type RailProps } from './components/Rail'
export {
  SessionTree,
  sessionTreeHostProps,
  type SessionTreeHostProps,
  type SessionTreeProps,
  type TreeHost,
  type TreeHostActions,
  type TreeReveal,
  type TreeSession
} from './components/SessionTree'
export {
  SessionEndedBar,
  formatDuration,
  type SessionEndedBarProps,
  type SessionLost
} from './components/SessionEndedBar'
export { SessionHistory, type HistoryGrouping, type SessionHistoryProps } from './components/SessionHistory'
export {
  SessionsPane,
  type SessionsPaneHost,
  type SessionsPaneProps,
  type SessionsPaneRemoteSession
} from './components/SessionsPane'
export { Sidebar, SidebarAction, type SidebarProps } from './components/Sidebar'
export { StatusBar, type StatusBarProps, type StatusHostItem, type StatusPluginItem } from './components/StatusBar'
export { TabBar, type Tab, type TabBarProps, type TabIndicator } from './components/TabBar'
export {
  BROWSER_PAGE_MIME,
  BrowserPages,
  type BrowserPage,
  type BrowserPagesProps
} from './components/BrowserPages'
export {
  PLUGIN_PAGE_MIME,
  PluginPages,
  type PluginPageTab,
  type PluginPagesProps
} from './components/PluginPages'
export { UsageStatus, type UsageStatusProps } from './components/UsageStatus'
export { TitleBar } from './components/TitleBar'
export { RestorePane, type RestorePaneProps } from './components/RestorePane'
export { WelcomePane, type WelcomePaneProps } from './components/WelcomePane'
export * from './components/icons'
export { cn } from './lib/cn'
export {
  COPIED_SHOWN_MS,
  COPY_REFUSED,
  copyPathLabel,
  PASTE_REFUSED,
  REFUSED_SHOWN_MS,
  useCopyFeedback,
  type CopyState
} from './lib/copyFeedback'
// Whether a dialog is up, for anything that has to get out of its way - the
// browser pane's `WebContentsView` first. `Overlay` is the only writer.
export { overlayOpen, subscribeOverlay, useOverlayOpen } from './lib/overlay'
export {
  hasPrimaryModifier,
  hostOs,
  isMac,
  shortcutLabel,
  type HostOs,
  type ModifierState,
  type PlatformSource,
  type ShortcutLabelOptions
} from './lib/platform'
export { formatAge, formatBytes, formatMoment, formatResetsIn } from './lib/time'
