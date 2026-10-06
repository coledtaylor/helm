export { AppShell, type AppShellProps } from './components/AppShell'
export {
  BrowserPane,
  BROWSER_WIDTHS,
  type BrowserPaneProps,
  type BrowserPaneState
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
export { VersionBanner, type VersionBannerProps } from './components/VersionBanner'
export { GitChip, type GitChipProps } from './components/GitChip'
export { InventoryChips, type InventoryChipsProps } from './components/InventoryChips'
export {
  ProfileEditor,
  type ProfileEditorProps,
  type ProfilePrediction
} from './components/ProfileEditor'
export { ProfileList, type ProfileListProps } from './components/ProfileList'
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
  type CrumbTone,
  type PaneCrumbProps,
  type PaneGroupProps
} from './components/PaneGroup'
export { PaneDrop, type PaneDropProps } from './components/PaneDrop'
export { PaneGrid, type PaneGridProps } from './components/PaneGrid'
export {
  PANE_MIN_HEIGHT,
  PANE_MIN_WIDTH,
  PANES_MOVED_EVENT,
  type PaneDropZone
} from './lib/paneGeometry'
export { Rail, type RailItem, type RailProps } from './components/Rail'
export { SessionTree, type SessionTreeProps, type TreeReveal, type TreeSession } from './components/SessionTree'
export {
  SessionEndedBar,
  formatDuration,
  type SessionEndedBarProps
} from './components/SessionEndedBar'
export {
  SessionHistory,
  type HistoryGrouping,
  type SessionHistoryProps
} from './components/SessionHistory'
export { SessionsPane, type SessionsPaneProps } from './components/SessionsPane'
export { Sidebar, SidebarAction, type SidebarProps } from './components/Sidebar'
export { StatusBar, type StatusBarProps, type StatusPluginItem } from './components/StatusBar'
export { TabBar, type Tab, type TabBarProps, type TabIndicator } from './components/TabBar'
export {
  BROWSER_PAGE_MIME,
  BrowserPages,
  type BrowserPage,
  type BrowserPagesProps
} from './components/BrowserPages'
export { UsageStatus, type UsageStatusProps } from './components/UsageStatus'
export { TitleBar } from './components/TitleBar'
export { RestorePane, type RestorePaneProps } from './components/RestorePane'
export { WelcomePane, type WelcomePaneProps } from './components/WelcomePane'
export * from './components/icons'
export { cn } from './lib/cn'
// Whether a dialog is up, for anything that has to get out of its way - the
// browser pane's `WebContentsView` first. `Overlay` is the only writer.
export { overlayOpen, subscribeOverlay, useOverlayOpen } from './lib/overlay'
export { formatAge, formatBytes, formatMoment, formatResetsIn } from './lib/time'
