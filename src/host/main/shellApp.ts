/**
 * The main-process composition root: owns what all windows share (settings, global state,
 * theme, display language, webview documents, the located extension, the ccw: protocol)
 * and the windows themselves. Each window (WindowContext) owns its workspace and its
 * extension host.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, clipboard, dialog, ipcMain, Menu, nativeTheme, net, safeStorage, session, shell } from 'electron';
import {
  AUTO_UPDATE_SETTING,
  DEFAULT_OPEN_VSX_URL,
  isVersion,
  OPEN_VSX_URL_SETTING,
  PINNED_VERSION_SETTING,
  targetPlatformOf,
} from '../../platform/extensionUpdates';
import type { ParamsOf, ResultOf } from '../../platform/ipc';
import { Disposable, toDisposable } from '../../platform/lifecycle';
import type { ILogger, LogLevel } from '../../platform/log';
import { LANGUAGE_SETTING, parseLanguageSetting, resolveUiLanguage, setUiLanguage, type UiLanguage } from '../../platform/nls';
import { TRANSLATE_EXTENSION_UI_SETTING, translateExtensionUi } from '../../platform/extensionStrings';
import {
  IpcChannel,
  type AppInfo,
  type ExtensionInstallResult,
  type ExtensionTranslations,
  type MainApiForRenderer,
  type MainEventsForRenderer,
  type ProvidersState,
  type StartupNotices,
  type ProviderNoticeDto,
  type RetentionDto,
  type SessionProvidersDto,
  type ThemeData,
  type ConversationStateDto,
  type SessionCostDto,
  type UsageTotalDto,
  type UsageViewDto,
} from '../../platform/protocol';
import { RELEASES_API_URL } from '../../platform/about';
import { ACCENT_COLOR_SETTING, ACCENT_SETTING, ACCENT_SOURCES, logoColor, parseColor, withAccent } from '../../platform/accent';
import { DELETE_SESSIONS_SETTING, LEGACY_KEEP_SESSIONS_SETTING } from '../../platform/defaults';
import { LOGO_COLOR } from '../../platform/logoMark';
import { URI_SCHEME } from '../../platform/product';
import {
  DEFAULT_PROVIDER_SETTING,
  providerAccentColor,
  providerSettingsOverlay,
  SUBSCRIPTION_ID,
  SUBSCRIPTION_PROVIDER,
  type ProviderConfig,
} from '../../platform/providers';
import { attributedProvider, CURRENT_PROVIDER_ONLY_SETTING, totalCost, type AttributedProvider } from '../../platform/usage';
import { API_ALLOW_SEND_SETTING, API_DISCOVERY_FILE, API_DOCS_URL, API_ENABLED_SETTING, API_PORT_SETTING } from '../../platform/localApi';
import { APP_ORIGIN } from '../../platform/webviewUrls';
import { extensionTranslations } from '../../nls/extensionPacks';
import { languagePack } from '../../nls/packs';
import { readOthersJsonFile } from '../node/jsonFile';
import { isSubPath } from '../node/paths';
import type { AppPaths } from './appPaths';
import { placeInWorkspace } from './attachments';
import { installCcwProtocol } from './ccwProtocol';
import type { CliArgs } from './cli';
import { locateClaudeExtension, type LocatedExtension } from './extensionLocator';
import { administratorInstanceArgs, startElevated } from './elevation';
import { ExplorerMenu, explorerMenuRoot, type ExplorerMenuLabels, type ExplorerMenuTarget } from './explorerMenu';
import { ExtensionStore } from './extensionStore';
import { ExtensionUpdater, type UpdateSettings } from './extensionUpdater';
import { findGit } from './gitLocator';
import { t } from './messages';
import { ProviderStore, type SecretCipher } from './providerStore';
import { ReleaseChecker } from './releaseChecker';
import { deleteSession, waitForSessionEnd } from './sessionFiles';
import { applyRetention } from './claudeRetention';
import { SessionTagWriter } from './sessionProviders';
import { scopeValue, usageTotal, usageView } from './usageView';
import { claudeProjectsDir, SessionSearch } from './sessionSearch';
import type { TranscriptLabels } from './transcriptMarkdown';
import { KeybindingsStore } from './keybindingsStore';
import { LocalApi } from './localApi';
import {
  builtInOperations,
  conversationEvents,
  usageScope,
  type ApiWindow,
  type ConversationTarget,
  type OperationsHost,
} from './localApiOperations';
import { LogoIcons, systemIconColor } from './logoIcons';
import { SettingsStore } from './settingsStore';
import { isExternalUrl, nextZoomLevel } from './shellWindow';
import { StateStore } from './stateStore';
import { EXTERNAL_TERMINAL_SETTING, findWindowsTerminal, openTerminal, terminalLaunch } from './terminal';
import { DEFAULT_THEME_ID, FONT_SETTING_KEYS, listThemeSummaries, loadTheme, readFontFaces, withFontVariables } from './themes';
import { WebviewDocumentStore } from './webviewDocuments';
import { WindowContext, type WindowHost } from './windowContext';
import { SharedRecentFolders } from './recentFolders';
import { cascade, foldersToOpen, parsePlacement, sameFolder, WindowHistory, type WindowPlacement } from './windowHistory';

/** The VS Code version we report to the extension. It gates features on this number. */
export const VSCODE_COMPAT_VERSION = '1.121.0';

const THEME_SETTING = 'vilaus.theme';
/** Settings that change the theme data (colors or font variables). */
const THEME_SETTING_KEYS = new Set<string>([THEME_SETTING, ACCENT_SETTING, ACCENT_COLOR_SETTING, ...FONT_SETTING_KEYS]);
/** Automatic updates of the extension: this long after the start, then at this interval. */
const FIRST_UPDATE_CHECK_MS = 15_000;
const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60_000;
const UPDATE_SETTING_KEYS = [AUTO_UPDATE_SETTING, PINNED_VERSION_SETTING, OPEN_VSX_URL_SETTING];
/** In state/shell.json: the missing-Git notice was shown (it is shown once). */
const GIT_NOTICE_KEY = 'gitNoticeShown';
/** Where the one window's placement and zoom were kept before there were several windows. */
const LEGACY_WINDOW_STATE_KEY = 'vilaus.window';
/** How long a session about to be deleted may take to stop running (its tab was just closed). */
const SESSION_END_TIMEOUT_MS = 10_000;
/** The session lists' mark of a provider with no accent of its own: the theme's muted text. */
const NO_ACCENT = 'var(--vscode-descriptionForeground)';
/** The local API's `windows` event waits this long for more changes to come with it. */
const API_WINDOWS_DELAY_MS = 50;

/** Provider keys at rest: Electron's safeStorage (DPAPI on Windows, for this Windows user). */
const electronCipher: SecretCipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
  decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64')),
};

export interface ShellEnvironment {
  readonly args: CliArgs;
  readonly paths: AppPaths;
  /** Directory containing main.js, preload.js, exthost.js, renderer/, themes/. */
  readonly appDir: string;
  readonly logger: ILogger;
  readonly logLevel: LogLevel;
}

/** The program File Explorer's entries start: in development electron.exe with the app's folder. */
export function explorerMenuTarget(): ExplorerMenuTarget {
  return { executable: process.execPath, prefixArgs: app.isPackaged ? [] : [app.getAppPath()] };
}

/** File Explorer's entries in the display language. */
/** The words of a full transcript (fullTranscripts.ts), in the display language. */
function transcriptLabels(): TranscriptLabels {
  return {
    you: t('transcriptYou'),
    claude: t('transcriptClaude'),
    thinking: t('transcriptThinking'),
    input: t('transcriptInput'),
    result: t('transcriptResult'),
    error: t('transcriptError'),
    noResult: t('transcriptNoResult'),
    oneLine: t('transcriptOneLine'),
    lines: t('transcriptLines'),
    moreLines: t('transcriptMoreLines'),
    image: t('transcriptImage'),
    subagent: t('transcriptSubagent'),
    compacted: t('transcriptCompacted'),
    summary: t('transcriptSummary'),
    plan: t('transcriptPlan'),
  };
}

export function explorerMenuLabels(): ExplorerMenuLabels {
  return { open: t('explorerOpen'), openAsAdministrator: t('explorerOpenAsAdministrator') };
}

/** Handlers for the page's calls; `window` is the window whose page called. */
type RendererHandlers = {
  [M in keyof MainApiForRenderer]: (
    params: ParamsOf<MainApiForRenderer, M>,
    window: WindowContext,
  ) => ResultOf<MainApiForRenderer, M> | Promise<ResultOf<MainApiForRenderer, M>>;
};

export class ShellApp extends Disposable implements WindowHost {
  readonly logger: ILogger;
  readonly settings: SettingsStore;
  private readonly keybindings: KeybindingsStore;
  readonly globalState: StateStore;
  readonly documents: WebviewDocumentStore;
  /** The display language of this run; a different setting applies after a restart. */
  readonly language: UiLanguage;
  readonly extensionTable: ExtensionTranslations | undefined;
  readonly providers: ProviderStore;
  /** The extension copies vilaus installs (Open VSX, .vsix files). */
  readonly extensionStore: ExtensionStore;
  private updater: ExtensionUpdater | undefined;
  private readonly shellState: StateStore;
  private readonly history: WindowHistory;
  private readonly sessionSearch: SessionSearch;
  private readonly sessionTags: SessionTagWriter;
  /** Claude Code's transcripts (`~/.claude/projects`), for the search and for deleting sessions. */
  private readonly projectsDir = claudeProjectsDir(process.env, os.homedir());
  /** Claude Code's own folder: the projects folder's parent (`CLAUDE_CONFIG_DIR` moves both). */
  readonly claudeConfigDir = path.dirname(this.projectsDir);
  /** File Explorer's "Open with Vilausity" entries. */
  private readonly explorerMenu = new ExplorerMenu(explorerMenuRoot(process.env), explorerMenuTarget());
  /** The app icon in the colors of windows' logos, for their icons and providers' shortcuts. */
  private readonly logoIcons: LogoIcons;
  private readonly themesDir: string;
  private currentTheme: ThemeData;
  private currentZoom: number;
  /** The old single window's placement, for the first window until each folder has its own. */
  private readonly legacyPlacement: WindowPlacement | undefined;
  private located: LocatedExtension | undefined;
  /** Open windows; the most recently focused one last. */
  private readonly windows: WindowContext[] = [];
  private nextWindowId = 1;
  private quitting = false;
  private cachedMachineId: string | undefined;
  /** What programs on this computer can ask (localApi.ts); serves while the setting is on. */
  private readonly localApi: LocalApi;
  /** GitHub's latest release, for the About section; shared by all windows. */
  private readonly releaseChecker: ReleaseChecker;
  /** The windows changed: the API's event stream hears of them shortly (several changes at once). */
  private apiWindowsTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly env: ShellEnvironment) {
    super();
    this.logger = env.logger;
    this.settings = this.register(new SettingsStore(env.paths.settingsFile, this.logger.child('settings')));
    this.keybindings = this.register(new KeybindingsStore(env.paths.keybindingsFile, this.logger.child('keybindings')));
    this.language = this.wantedLanguage();
    setUiLanguage(this.language, languagePack(this.language));
    this.logger.info(`display language: ${this.language}`);
    this.globalState = new StateStore(env.paths.globalStateFile, this.logger.child('state'));
    this.shellState = new StateStore(env.paths.shellStateFile, this.logger.child('state'));
    this.history = new WindowHistory(
      this.shellState,
      new SharedRecentFolders(env.paths.recentFoldersFile, this.logger.child('recentFolders')),
    );
    this.history.shareRecent();
    this.history.shareOtherRecent(() => readOthersJsonFile(env.paths.otherShellStateFile));
    const legacy = this.globalState.get(LEGACY_WINDOW_STATE_KEY) as { zoomLevel?: unknown } | undefined;
    this.legacyPlacement = parsePlacement(legacy);
    if (legacy !== undefined) {
      if (this.history.zoomLevel() === undefined && typeof legacy.zoomLevel === 'number') {
        this.history.setZoomLevel(legacy.zoomLevel);
      }
      this.globalState.set(LEGACY_WINDOW_STATE_KEY, undefined);
    }
    this.currentZoom = this.history.zoomLevel() ?? 0;
    this.providers = this.register(new ProviderStore(env.paths.providersFile, electronCipher, this.logger.child('providers')));
    this.sessionTags = new SessionTagWriter(env.paths.sessionProvidersFile);
    this.sessionSearch = this.register(
      new SessionSearch(
        path.join(env.appDir, 'sessionSearchWorker.js'),
        this.projectsDir,
        env.paths.sessionProvidersFile,
        env.paths.usageLedgerFile,
        this.logger.child('sessionSearch'),
      ),
    );
    this.extensionStore = new ExtensionStore(
      env.paths.extensionsDir,
      targetPlatformOf(process.platform, process.arch),
      this.logger.child('extensions'),
    );
    this.logoIcons = new LogoIcons(env.paths.iconsDir, this.logger.child('icons'));
    this.themesDir = path.join(env.appDir, 'themes');
    const themeId = env.args.theme ?? stringSetting(this.settings.all[THEME_SETTING]) ?? DEFAULT_THEME_ID;
    this.currentTheme = withFontVariables(loadTheme(this.themesDir, themeId, this.logger), this.settings.all);
    const bootstrap = fs.readFileSync(path.join(env.appDir, 'webview-bootstrap.js'), 'utf8');
    this.extensionTable = extensionTranslations(this.language);
    this.documents = new WebviewDocumentStore(
      bootstrap,
      // A window's webviews start in its accent.
      (owner) => this.windows.find((window) => window.ownsDocuments(owner))?.theme ?? this.theme,
      () => this.extensionTranslations(),
      readFontFaces(path.join(env.appDir, 'renderer', 'fonts', 'fonts.css'), this.logger),
      (key) => this.settings.all[key] === true,
    );
    this.releaseChecker = new ReleaseChecker({
      // The environment variable points UI tests at a local stand-in instead of GitHub.
      url: process.env.VILAUS_RELEASES_API_URL || RELEASES_API_URL,
      fetch: (url, init) => net.fetch(url, init),
      logger: this.logger.child('about'),
    });
    this.localApi = this.register(
      new LocalApi({
        discoveryFile: path.join(env.paths.instanceRoot, API_DISCOVERY_FILE),
        elevated: env.paths.elevated,
        version: app.getVersion(),
        settings: () => this.settings.all,
        window: (id) => {
          const window = id === undefined ? this.windows.at(-1) : this.windowById(id);
          return window && { id: window.id, call: (name, params) => window.callPage(name, params) };
        },
        greeting: () => [{ name: 'windows', data: this.apiWindows() }],
        info: () => ({
          app: 'Vilausity',
          version: app.getVersion(),
          extension: this.located ? { version: this.located.version } : null,
          elevated: env.paths.elevated,
          allowSend: !env.paths.elevated && this.settings.all[API_ALLOW_SEND_SETTING] === true,
          docs: API_DOCS_URL,
        }),
        logger: this.logger.child('api'),
      }),
    );
  }

  get theme(): ThemeData {
    return this.currentTheme;
  }

  get zoomLevel(): number {
    return this.currentZoom;
  }

  /** Undefined until the extension is installed (the windows show the first-run page meanwhile). */
  get extension(): LocatedExtension | undefined {
    return this.located;
  }

  async start(): Promise<void> {
    const { extensionDir, ignoreOtherEditors } = this.env.args;
    // A version installed last run becomes current now, before any extension host loads it.
    this.located = locateClaudeExtension(extensionDir, this.extensionStore.prepare(), !ignoreOtherEditors);
    const updater = this.register(
      new ExtensionUpdater({
        store: this.extensionStore,
        fetch: (url, init) => net.fetch(url, init),
        targetPlatform: this.extensionStore.targetPlatform,
        running: this.located,
        // Another editor's copy, whichever runs: the version to go back to after the first update.
        external: ignoreOtherEditors ? undefined : locateClaudeExtension(),
        settings: () => this.updateSettings(),
        logger: this.logger.child('extensions'),
      }),
    );
    this.updater = updater;
    this.register(updater.onDidChange(() => this.broadcast('extensionStatus', updater.status())));
    if (this.located) {
      this.logger.info(`Claude Code ${this.located.version} from ${this.located.path} (via ${this.located.source})`);
    } else if (extensionDir) {
      // A developer's mistake: say so rather than offer to install.
      dialog.showErrorBox('Vilausity', t('extensionDirInvalid', extensionDir));
      app.quit();
      return;
    } else {
      this.logger.info('Claude Code is not installed: the windows show the first-run page');
    }

    installCcwProtocol(session.defaultSession, {
      appDir: path.join(this.env.appDir, 'renderer'),
      documents: this.documents,
      imageRoots: () => this.windows.flatMap((window) => window.folders),
      logger: this.logger.child('ccw'),
    });
    this.registerRendererHandlers();
    this.settings.watch();
    this.register(this.settings.onDidChange(({ keys }) => this.settingsChanged(keys)));
    this.keybindings.watch();
    this.register(this.keybindings.onDidChange(() => this.broadcast('keybindingsChanged', { entries: this.keybindings.entries })));
    this.register(
      this.providers.onDidChange(() => {
        for (const window of this.windows) {
          if (this.providers.get(window.provider)) {
            window.providersChanged();
          } else {
            // Its provider was removed.
            window.setProvider(SUBSCRIPTION_ID);
          }
        }
        this.apiWindowsChanged();
      }),
    );
    // The taskbar turned dark or light: icons drawn to show on it may have to change.
    const onNativeThemeUpdated = (): void => this.windows.forEach((window) => window.refreshIcon());
    nativeTheme.on('updated', onNativeThemeUpdated);
    this.register(toDisposable(() => nativeTheme.off('updated', onNativeThemeUpdated)));
    // A quit from elsewhere (app.quit()) would close the windows one by one, and only the
    // last would be restored; quit the way the Exit command does instead.
    const onBeforeQuit = (event: Electron.Event): void => {
      if (!this.quitting) {
        event.preventDefault();
        void this.quit();
      }
    };
    app.on('before-quit', onBeforeQuit);
    this.register(toDisposable(() => app.off('before-quit', onBeforeQuit)));
    const args = this.env.args;
    const folders = foldersToOpen({
      folder: args.folder && !isFile(args.folder) ? resolveWorkspaceFolder(args.folder, this.logger) : undefined,
      restoreAll: this.history.takeRestoreAll(),
      previous: this.history.openWindows(),
      exists: isDirectory,
      fallback: os.homedir(),
    });
    for (const folder of folders) {
      await this.openWindow(folder);
    }
    await this.applyCommandLine(args, true);
    this.scheduleUpdateChecks();
    void this.migrateKeepForever().then(() => this.keepSessions());
    this.localApi.registerOperations(builtInOperations(this.apiHost()));
    this.register(this.localApi.onDidChangeStatus((status) => this.broadcast('apiStatus', status)));
    void this.localApi.apply();
    // Not in development: there the entries would point at electron.exe and this checkout.
    if (app.isPackaged) {
      this.refreshExplorerMenu().catch((error: unknown) => this.logger.warn("cannot rewrite File Explorer's menu entries", error));
    }
  }

  /** A second start's arguments: its folder, file, conversation or link, in the right window. */
  handleCommandLine(args: CliArgs): Promise<void> {
    return this.applyCommandLine(args, false);
  }

  /** Opens `folder` in a window of its own, or brings the window that shows it to the front. */
  async openWindow(folder: string, provider?: string): Promise<WindowContext> {
    const existing = this.windowFor(folder);
    if (existing) {
      existing.focus();
      return existing;
    }
    const window = new WindowContext(this, {
      id: this.nextWindowId++,
      folder,
      placement: this.placementFor(folder),
      provider: provider && this.providers.get(provider) ? provider : this.initialProvider(folder),
    });
    this.windows.push(window);
    window.browserWindow.on('focus', () => this.markActive(window));
    this.history.addRecent(folder);
    this.rememberOpenWindows();
    this.apiWindowsChanged();
    this.logger.info(`window ${window.id}: ${folder}`);
    await window.load();
    return window;
  }

  requestClose(window: WindowContext): void {
    if (this.quitting) {
      return;
    }
    if (this.windows.length <= 1) {
      // The last window: it is the one to restore at the next start.
      void this.quit();
    } else {
      void this.closeWindow(window);
    }
  }

  /** Closes every window; all of them open again at the next start. */
  async quit(): Promise<void> {
    if (this.quitting) {
      return;
    }
    this.quitting = true;
    this.logger.info('shutting down');
    for (const window of this.windows) {
      this.history.rememberPlacement(window.folder, window.window.placement);
    }
    this.rememberOpenWindows();
    await Promise.all(this.windows.map((window) => window.shutdown()));
    await Promise.all([this.globalState.flush(), this.shellState.flush()]);
    for (const window of this.windows.splice(0)) {
      window.destroy();
    }
    app.quit();
  }

  /** Quits and starts again with every window that is open now, whatever the command line says. */
  relaunch(): void {
    this.history.setRestoreAll(true);
    app.relaunch();
    void this.quit();
  }

  /** Synchronous last-chance persistence for abrupt exits. */
  flushSync(): void {
    this.globalState.flushSync();
    this.shellState.flushSync();
    for (const window of this.windows) {
      window.flushSync();
    }
  }

  globalStateChanged(source: WindowContext, key: string, value: unknown): void {
    for (const window of this.windows) {
      if (window !== source) {
        window.globalStateChanged(key, value);
      }
    }
  }

  extensionActivated(version: string): void {
    if (this.located?.kind === 'managed' && this.located.version === version) {
      this.extensionStore.markGood(version).catch((error: unknown) => this.logger.error('recording a working version failed', error));
    }
  }

  /** The version to go back to, when the running one came from an update and has never activated. */
  rollbackTarget(): string | undefined {
    const { current, lastGood } = this.extensionStore.state;
    if (this.located?.kind !== 'managed' || this.located.version !== current || lastGood === current) {
      return undefined;
    }
    return this.updater?.rollbackTarget()?.version;
  }

  async rollBackAndRelaunch(): Promise<void> {
    const result = await this.updater?.rollBack();
    if (result?.outcome === 'installed') {
      this.relaunch();
    }
  }

  providerOverlay(providerId: string): Record<string, unknown> {
    const provider = this.providers.get(providerId) ?? SUBSCRIPTION_PROVIDER;
    return providerSettingsOverlay(provider, this.providers.key(provider.id), this.settings.all);
  }

  providersState(current: string): ProvidersState {
    return { providers: this.providers.list(), current };
  }

  /**
   * The accent of a window whose provider is `providerId`, as the `vilaus.accent` setting asks
   * (the provider's by default); undefined for none (VS Code's own colors).
   */
  private windowAccent(providerId: string): string | undefined {
    const settings = this.settings.all;
    const source = ACCENT_SOURCES.find((candidate) => candidate === settings[ACCENT_SETTING]) ?? 'provider';
    const custom = settings[ACCENT_COLOR_SETTING];
    return source === 'provider'
      ? providerAccentColor(this.providers.get(providerId) ?? SUBSCRIPTION_PROVIDER)
      : source === 'custom' && typeof custom === 'string' && parseColor(custom)
        ? custom
        : undefined;
  }

  /** The theme of a window whose provider is `providerId`: the shared one in the window's accent. */
  windowTheme(providerId: string): ThemeData {
    return withAccent(this.theme, this.windowAccent(providerId));
  }

  /** The icon file of a window whose provider is `providerId`: the app's, or the app's in its logo's color. */
  windowIcon(providerId: string): string {
    return this.logoIconFile(providerId) ?? this.appIcon;
  }

  /** The app icon as the build copies it next to main.js. */
  private get appIcon(): string {
    return path.join(this.env.appDir, 'icon.ico');
  }

  /** The icon drawn in the logo color of `providerId`'s windows; undefined when that is the app's own. */
  private logoIconFile(providerId: string): string | undefined {
    const color = systemIconColor(logoColor(this.windowAccent(providerId)), nativeTheme.shouldUseDarkColorsForSystemIntegratedUI);
    return color === LOGO_COLOR ? undefined : this.logoIcons.file(color);
  }

  tagSession(sessionId: string, providerId: string, at: number): void {
    const name = this.providers.get(providerId)?.name ?? '';
    this.sessionTags.add(sessionId, { provider: providerId, name, at }).then(
      () => this.logger.info(`session ${sessionId} runs under provider ${providerId}`),
      (error: unknown) => this.logger.error(`cannot tag session ${sessionId}`, error),
    );
  }

  /**
   * A compatible API's conversations cost what the shell works out with its prices; the
   * extension prices every model it does not know as Claude's. Claude's own APIs it prices right.
   */
  shellPricing(providerId: string): boolean {
    return this.providers.get(providerId)?.type === 'compatible';
  }

  async usageView(window: WindowContext, sessionId: string | undefined): Promise<UsageViewDto | null> {
    const provider = this.providers.get(window.provider);
    if (provider?.type !== 'compatible') {
      return null;
    }
    const scopes = await this.sessionSearch.usage({
      kind: 'summary',
      providers: this.attributedProviders(),
      provider: provider.id,
      sessionId,
      folder: window.folder,
      pricing: provider.pricing,
    });
    return usageView(scopes, provider.name || provider.id, provider.pricing, sessionId !== undefined);
  }

  /** A compatible API's total, deleted sessions included (`usage.total`). */
  async usageTotal(providerId: string): Promise<UsageTotalDto | null> {
    const provider = this.providers.get(providerId);
    if (provider?.type !== 'compatible') {
      return null;
    }
    const models = await this.sessionSearch.usage({
      kind: 'total',
      providers: this.attributedProviders(),
      provider: provider.id,
      pricing: provider.pricing,
    });
    return usageTotal(models, provider.pricing);
  }

  /** What a session cost under the compatible APIs it ran under (`usage.sessionCost`). */
  async sessionCost(sessionId: string): Promise<SessionCostDto[]> {
    const compatible = this.providers.list().filter((provider) => provider.type === 'compatible');
    if (compatible.length === 0) {
      return [];
    }
    const byProvider = await this.sessionSearch.usage({
      kind: 'session',
      providers: this.attributedProviders(),
      sessionId,
      pricing: Object.fromEntries(compatible.flatMap((provider) => (provider.pricing ? [[provider.id, provider.pricing]] : []))),
    });
    return compatible.flatMap((provider) => {
      const models = byProvider[provider.id] ?? {};
      const used = Object.keys(models).length;
      if (used === 0) {
        return [];
      }
      const priced = totalCost(models, provider.pricing).unpriced.length < used;
      const cost = priced ? scopeValue(models, provider.pricing, provider.pricing?.currency ?? 'USD') : '';
      return [{ name: provider.name || provider.id, cost }];
    });
  }

  private attributedProviders(): AttributedProvider[] {
    return this.providers.list().map(attributedProvider);
  }

  private providerName(provider: ProviderConfig): string {
    return provider.type === 'subscription' ? t('subscription') : provider.name || provider.id;
  }

  async sessionProviders(window: WindowContext): Promise<SessionProvidersDto> {
    const sessions = await this.sessionSearch.usage({ kind: 'sessionProviders', providers: this.attributedProviders() });
    const providers = Object.fromEntries(
      this.providers
        .list()
        .map((provider) => [provider.id, { name: this.providerName(provider), color: providerAccentColor(provider) ?? NO_ACCENT }]),
    );
    const current = this.providers.get(window.provider) ?? SUBSCRIPTION_PROVIDER;
    return {
      sessions,
      providers,
      current: current.id,
      onlyCurrent: this.settings.all[CURRENT_PROVIDER_ONLY_SETTING] === true,
      filterTitle: t('providerFilter', this.providerName(current)),
    };
  }

  /**
   * A session the window opens ran under another provider last: going on with this one can
   * fail (one API's replies are not always what another takes back), so the conversation says so.
   */
  async providerNotice(window: WindowContext, sessionId: string): Promise<ProviderNoticeDto | null> {
    const last = await this.sessionSearch.usage({ kind: 'lastProvider', providers: this.attributedProviders(), sessionId });
    if (last === undefined || last === window.provider) {
      return null;
    }
    const provider = this.providers.get(last);
    const name = provider ? this.providerName(provider) : last;
    const current = this.providerName(this.providers.get(window.provider) ?? SUBSCRIPTION_PROVIDER);
    this.logger.info(`session ${sessionId} last ran under ${last}, opened under ${window.provider}`);
    return {
      sessionId,
      text: t('providerNotice', name, current),
      switchTo: provider ? last : undefined,
      switchLabel: provider ? t('providerNoticeSwitch', name) : undefined,
      ignoreLabel: t('providerNoticeIgnore'),
    };
  }

  /** The folder's provider from last time, else the default setting's, else the subscription. */
  initialProvider(folder: string): string {
    const remembered = this.history.folderProvider(folder);
    if (remembered && this.providers.get(remembered)) {
      return remembered;
    }
    const preferred = this.settings.all[DEFAULT_PROVIDER_SETTING];
    return typeof preferred === 'string' && this.providers.get(preferred) ? preferred : SUBSCRIPTION_ID;
  }

  appInfo(): AppInfo {
    return {
      appName: 'Vilausity (VSCodium)',
      vscodeVersion: VSCODE_COMPAT_VERSION,
      uriScheme: URI_SCHEME,
      language: this.language,
      machineId: this.machineId(),
      sessionId: crypto.randomUUID(),
      shell: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    };
  }

  async openExternal(url: string): Promise<boolean> {
    if (!isExternalUrl(url)) {
      this.logger.warn(`refused to open non-web URL externally: ${url}`);
      return false;
    }
    await shell.openExternal(url);
    return true;
  }

  /**
   * Opens a folder in a new window, or in place of `inWindow`'s workspace. A folder that
   * some window shows already just brings that window to the front.
   */
  private async openFolder(folder: string, inWindow: WindowContext | undefined): Promise<boolean> {
    if (!isDirectory(folder)) {
      this.logger.warn(`cannot open ${folder}: not a folder`);
      this.history.removeRecent(folder);
      return false;
    }
    const existing = this.windowFor(folder);
    if (existing) {
      existing.focus();
    } else if (!inWindow) {
      await this.openWindow(folder);
    } else {
      this.history.rememberPlacement(inWindow.folder, inWindow.window.placement);
      // Before the switch, which waits for the extension host to stop and may fail on the way.
      this.history.addRecent(folder);
      await inWindow.switchFolder(folder);
      this.rememberOpenWindows();
      this.apiWindowsChanged();
    }
    return true;
  }

  /**
   * Where a start's arguments go: a folder to its own window; a file (positional or
   * --goto) to the window whose folder holds it, else the active one; nothing to the
   * active window (a new one with --new-window, for a second start).
   */
  private async applyCommandLine(args: CliArgs, initial: boolean): Promise<void> {
    const file = args.folder && isFile(args.folder) ? args.folder : undefined;
    const folder = args.folder && !file && isDirectory(args.folder) ? args.folder : undefined;
    const goto = args.goto ?? (file ? { path: file } : undefined);
    let window: WindowContext | undefined;
    if (folder) {
      window = await this.openWindow(folder);
    } else if (goto) {
      window = this.windows.find((candidate) => isSubPath(goto.path, candidate.folder)) ?? this.windows.at(-1);
    } else if (args.newWindow && !initial) {
      window = await this.openWindow(os.homedir());
    } else {
      window = this.windows.at(-1);
    }
    if (!window) {
      return;
    }
    if (!initial) {
      window.focus();
    }
    if (args.provider) {
      if (this.providers.get(args.provider)) {
        this.selectProvider(window, args.provider);
      } else {
        this.logger.warn(`--provider ${args.provider}: no such provider`);
      }
    }
    if (args.session || args.prompt) {
      window.openConversation({ sessionId: args.session, prompt: args.prompt });
    }
    if (goto) {
      window.showFile(goto);
    }
    if (args.uri) {
      window.openUri(args.uri);
    }
  }

  private async closeWindow(window: WindowContext): Promise<void> {
    this.history.rememberPlacement(window.folder, window.window.placement);
    const index = this.windows.indexOf(window);
    if (index >= 0) {
      this.windows.splice(index, 1);
    }
    this.rememberOpenWindows();
    this.localApi.windowClosed(window.id);
    this.apiWindowsChanged();
    await window.shutdown();
    window.destroy();
  }

  /** The window's new conversations use `id` from now on, and its folder remembers it. */
  private selectProvider(window: WindowContext, id: string): void {
    window.setProvider(id);
    this.history.rememberFolderProvider(window.folder, id);
    this.apiWindowsChanged();
  }

  /**
   * A desktop shortcut that starts Vilausity with this provider (`--provider <id>`), its icon
   * in the color of the logo its windows show now (made again, it follows a new color).
   */
  private createShortcut(id: string): string {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`no provider ${id}`);
    }
    const label = (provider.name || 'Claude').replace(/[\\/:*?"<>|]+/g, ' ').trim();
    const file = path.join(app.getPath('desktop'), `Vilausity (${label}).lnk`);
    // In development the executable is electron.exe, which needs the app's folder first and
    // has Electron's icon.
    const args = [...(app.isPackaged ? [] : [`"${app.getAppPath()}"`]), '--provider', id].join(' ');
    const icon = this.logoIconFile(id) ?? (app.isPackaged ? process.execPath : this.appIcon);
    const written = shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', {
      target: process.execPath,
      args,
      description: `Vilausity - ${label}`,
      icon,
      iconIndex: 0,
    });
    if (!written) {
      throw new Error(`could not write ${file}`);
    }
    this.logger.info(`created the shortcut ${file}`);
    return file;
  }

  private windowFor(folder: string): WindowContext | undefined {
    return this.windows.find((window) => sameFolder(window.folder, folder));
  }

  /** Keeps the most recently focused window last. */
  private markActive(window: WindowContext): void {
    const index = this.windows.indexOf(window);
    if (index >= 0 && index !== this.windows.length - 1) {
      this.windows.splice(index, 1);
      this.windows.push(window);
      this.rememberOpenWindows();
      this.apiWindowsChanged();
    }
  }

  private windowById(id: number): WindowContext | undefined {
    return this.windows.find((window) => window.id === id);
  }

  /** The window `id` names, the active one when there is no id. */
  private apiTarget(id: number | undefined): WindowContext | undefined {
    return id === undefined ? this.windows.at(-1) : this.windowById(id);
  }

  /**
   * Where the local API's conversation goes: a session open in a window goes on there (a second
   * Claude process on it elsewhere would fight the first); else the folder's window (opened when
   * there is none: `opened`), the window named, or the active one.
   */
  private async conversationWindow(
    target: ConversationTarget,
    sessionId: string | undefined,
  ): Promise<{ window: WindowContext; opened: boolean } | undefined> {
    const showing = sessionId
      ? this.windows.find((window) => window.conversations.some((conversation) => conversation.sessionId === sessionId))
      : undefined;
    if (showing) {
      return { window: showing, opened: false };
    }
    if (target.folder !== undefined) {
      if (!isDirectory(target.folder)) {
        return undefined;
      }
      const opened = !this.windowFor(target.folder);
      return { window: await this.openWindow(target.folder), opened };
    }
    const window = this.apiTarget(target.window);
    return window && { window, opened: false };
  }

  conversationsChanged(window: WindowContext, previous: readonly ConversationStateDto[]): void {
    for (const event of conversationEvents(window, previous, window.conversations)) {
      this.localApi.emit(event.name, event.data);
    }
    this.apiWindowsChanged();
  }

  private apiWindowsChanged(): void {
    this.apiWindowsTimer ??= setTimeout(() => {
      this.apiWindowsTimer = undefined;
      this.localApi.emit('windows', this.apiWindows());
    }, API_WINDOWS_DELAY_MS);
  }

  private apiWindows(): ApiWindow[] {
    const active = this.windows.at(-1);
    return this.windows.map((window) => {
      const provider = this.providers.get(window.provider) ?? SUBSCRIPTION_PROVIDER;
      return {
        id: window.id,
        folder: window.folder,
        active: window === active,
        provider: { id: provider.id, name: this.providerName(provider), type: provider.type },
        activeSessionId: window.activeSessionId,
        conversations: window.conversations,
      };
    });
  }

  /** What the local API's own operations do (localApiOperations.ts). */
  private apiHost(): OperationsHost {
    return {
      windows: () => this.apiWindows(),
      focusWindow: (id) => {
        const window = this.windowById(id);
        window?.focus();
        return window !== undefined;
      },
      openFolder: async (folder) => (isDirectory(folder) ? (await this.openWindow(folder)).id : undefined),
      openFile: (file, line, column) => {
        const window = isFile(file)
          ? (this.windows.find((candidate) => isSubPath(file, candidate.folder)) ?? this.windows.at(-1))
          : undefined;
        window?.focus();
        window?.showFile({ path: file, line, column });
        return window?.id;
      },
      openConversation: async (target, request) => {
        const found = await this.conversationWindow(target, request.sessionId);
        if (!found) {
          return undefined;
        }
        const { window, opened } = found;
        window.focus();
        // A window that just opened has a new conversation of its own.
        if (request.sessionId || request.prompt || !opened) {
          window.openConversation(request);
        }
        return window.id;
      },
      sendPrompt: async (target, request) => {
        const found = await this.conversationWindow(target, request.sessionId);
        if (!found) {
          return undefined;
        }
        const { window, opened } = found;
        if (opened) {
          window.skipInitialConversation();
        }
        window.focus();
        return { window: window.id, result: await window.sendPrompt(request) };
      },
      searchSessions: (request) => this.sessionSearch.search(request),
      usage: async (id) => {
        const window = this.apiTarget(id);
        if (!window) {
          return undefined;
        }
        const provider = this.providers.get(window.provider);
        if (provider?.type !== 'compatible') {
          return null;
        }
        const scopes = await this.sessionSearch.usage({
          kind: 'summary',
          providers: this.attributedProviders(),
          provider: provider.id,
          sessionId: window.activeSessionId,
          folder: window.folder,
          pricing: provider.pricing,
        });
        return {
          provider: { id: provider.id, name: this.providerName(provider) },
          currency: provider.pricing?.currency ?? 'USD',
          conversation: window.activeSessionId ? usageScope(scopes.session, provider.pricing) : null,
          workspace: usageScope(scopes.folder, provider.pricing),
          all: usageScope(scopes.all, provider.pricing),
        };
      },
    };
  }

  /** Kept current, so even after a crash the next start reopens what was open. */
  private rememberOpenWindows(): void {
    this.history.setOpenWindows(this.windows.map((window) => window.folder));
  }

  /** Where a new window for `folder` goes: where it was last time, else a step off the active window. */
  private placementFor(folder: string): WindowPlacement {
    const taken = this.windows.flatMap((window) => window.window.placement.bounds ?? []);
    const saved = this.history.placement(folder) ?? (this.windows.length === 0 ? this.legacyPlacement : undefined);
    if (saved?.bounds) {
      return { ...saved, bounds: cascade(saved.bounds, taken) };
    }
    const active = this.windows.at(-1)?.window.placement;
    if (active?.bounds) {
      return { bounds: cascade(active.bounds, taken), maximized: active.maximized };
    }
    return saved ?? {};
  }

  private broadcast<K extends keyof MainEventsForRenderer>(name: K, payload: MainEventsForRenderer[K]): void {
    for (const window of this.windows) {
      window.emit(name, payload);
    }
  }

  private settingsChanged(keys: readonly string[]): void {
    for (const window of this.windows) {
      window.settingsChanged(keys);
    }
    if (keys.some((key) => UPDATE_SETTING_KEYS.includes(key))) {
      this.checkForUpdatesAutomatically();
    }
    if (keys.includes(DELETE_SESSIONS_SETTING)) {
      void this.keepSessions();
    }
    if (keys.includes(API_ENABLED_SETTING) || keys.includes(API_PORT_SETTING)) {
      void this.localApi.apply();
    }
    if (keys.some((key) => THEME_SETTING_KEYS.has(key))) {
      this.reloadTheme();
    }
    if (keys.includes(TRANSLATE_EXTENSION_UI_SETTING) && this.extensionTable) {
      this.broadcast('extensionTranslationsChanged', { translations: this.extensionTranslations() ?? null });
    }
    if (keys.includes(LANGUAGE_SETTING)) {
      const wanted = this.wantedLanguage();
      if (wanted !== this.language) {
        this.broadcast('languageChanged', { language: wanted });
      }
    }
  }

  private updateSettings(): UpdateSettings {
    const pinned = this.settings.all[PINNED_VERSION_SETTING];
    return {
      openVsxUrl: stringSetting(this.settings.all[OPEN_VSX_URL_SETTING]) ?? DEFAULT_OPEN_VSX_URL,
      pinned: isVersion(pinned) ? pinned : undefined,
    };
  }

  /**
   * `vilaus.sessions.keepForever` came before `deleteAfterDays`: on (the default) was never,
   * off left Claude Code's own 30 days.
   */
  private async migrateKeepForever(): Promise<void> {
    const legacy = this.settings.all[LEGACY_KEEP_SESSIONS_SETTING];
    if (legacy === undefined) {
      return;
    }
    if (legacy === false && this.settings.all[DELETE_SESSIONS_SETTING] === undefined) {
      await this.settings.set(DELETE_SESSIONS_SETTING, 30);
    }
    await this.settings.set(LEGACY_KEEP_SESSIONS_SETTING, undefined);
  }

  /** Claude Code's `cleanupPeriodDays` as `vilaus.sessions.deleteAfterDays` wants it (claudeRetention.ts). */
  private async keepSessions(): Promise<RetentionDto> {
    const value = this.settings.all[DELETE_SESSIONS_SETTING];
    const days = typeof value === 'number' && value > 0 ? value : 0;
    const file = path.join(this.claudeConfigDir, 'settings.json');
    try {
      const state = await applyRetention(this.claudeConfigDir, days, this.env.paths.claudeRetentionFile);
      if (state.wrote !== undefined) {
        this.logger.info(`Claude Code's cleanupPeriodDays set to ${state.wrote} days (${DELETE_SESSIONS_SETTING})`);
      }
      return { days: state.days ?? null, ownValue: state.ownValue, file };
    } catch (error) {
      this.logger.warn("cannot set Claude Code's cleanupPeriodDays", error);
      return { days: null, ownValue: false, file };
    }
  }

  /** Shortly after the start, then twice a day (and when the update settings change). */
  private scheduleUpdateChecks(): void {
    const first = setTimeout(() => this.checkForUpdatesAutomatically(), FIRST_UPDATE_CHECK_MS);
    const every = setInterval(() => this.checkForUpdatesAutomatically(), UPDATE_CHECK_INTERVAL_MS);
    this.register(
      toDisposable(() => {
        clearTimeout(first);
        clearInterval(every);
      }),
    );
  }

  /**
   * Installs what Open VSX offers, if automatic updates are on; the version is used from the
   * next start. Not before the first install: the first-run page asks for that. Only the
   * normal instance updates on its own; the administrator instance shares what it installs.
   */
  private checkForUpdatesAutomatically(): void {
    const updater = this.updater;
    if (
      !this.located ||
      !updater?.updatesApply ||
      this.env.paths.elevated ||
      this.settings.all[AUTO_UPDATE_SETTING] === false ||
      this.quitting
    ) {
      return;
    }
    void updater.check(false).then((result) => {
      if (result.outcome === 'installed') {
        this.windows.at(-1)?.emit('extensionUpdated', { version: result.version });
      }
    });
  }

  /** The table webviews translate the extension's UI with now: the setting can turn it off. */
  private extensionTranslations(): ExtensionTranslations | undefined {
    return this.extensionTable && translateExtensionUi(this.settings.all) ? this.extensionTable : undefined;
  }

  private wantedLanguage(): UiLanguage {
    return resolveUiLanguage(this.settings.all[LANGUAGE_SETTING], app.getPreferredSystemLanguages());
  }

  /** Recomputes the theme from settings (theme id, fonts) and pushes it to the windows. */
  private reloadTheme(): void {
    const id = stringSetting(this.settings.all[THEME_SETTING]) ?? DEFAULT_THEME_ID;
    this.applyTheme(withFontVariables(loadTheme(this.themesDir, id, this.logger), this.settings.all));
  }

  private applyTheme(theme: ThemeData): void {
    this.currentTheme = theme;
    for (const window of this.windows) {
      window.refreshTheme();
    }
  }

  private registerRendererHandlers(): void {
    const handlers: RendererHandlers = {
      'app.getInitData': (_params, window) => window.rendererInitData(),
      'app.latestRelease': ({ force }) => this.releaseChecker.latest(force === true),
      'app.listThemes': () => listThemeSummaries(this.themesDir),
      'app.setTheme': async ({ id }) => {
        const theme = withFontVariables(loadTheme(this.themesDir, id, this.logger), this.settings.all);
        this.applyTheme(theme);
        await this.settings.set(THEME_SETTING, theme.id);
        return theme;
      },
      'app.restartExtensionHost': (_params, window) => window.restartExtensionHost(),
      'app.getLanguage': () => ({
        setting: parseLanguageSetting(this.settings.all[LANGUAGE_SETTING]),
        running: this.language,
      }),
      'app.setLanguage': ({ setting }) => {
        const parsed = parseLanguageSetting(setting);
        // `auto` is the default, so it is stored by removing the key.
        return this.settings.set(LANGUAGE_SETTING, parsed === 'auto' ? undefined : parsed);
      },
      'app.relaunch': () => this.relaunch(),
      'app.quit': () => void this.quit(),
      'os.openExternal': ({ url }) => this.openExternal(url),
      'os.notify': ({ title, body }, window) => window.window.notify(title, body),
      'os.openFolder': async ({ path: folder }) => {
        const error = await shell.openPath(folder);
        if (error) {
          this.logger.warn(`cannot open ${folder} in the file manager: ${error}`);
        }
      },
      'os.openTerminal': async ({ folder }) => {
        const comspec = process.env.ComSpec ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
        const launch = terminalLaunch(this.settings.all[EXTERNAL_TERMINAL_SETTING], findWindowsTerminal(), comspec);
        try {
          await openTerminal(folder, launch);
          return true;
        } catch (error) {
          this.logger.warn(`cannot open a terminal in ${folder}`, error);
          return false;
        }
      },
      'settings.read': () => ({ values: { ...this.settings.all }, filePath: this.settings.filePath }),
      'settings.update': ({ key, value }) => this.settings.set(key, value),
      'keybindings.read': () => ({ entries: [...this.keybindings.entries], filePath: this.keybindings.filePath }),
      'keybindings.edit': ({ remove, add }) => this.keybindings.edit(remove, add),
      'window.toggleDevTools': (_params, window) => window.webContents.toggleDevTools(),
      'window.pickFolder': async (_params, window) => {
        const result = await dialog.showOpenDialog(window.browserWindow, {
          properties: ['openDirectory'],
          defaultPath: path.dirname(window.folder),
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
      'window.openFolder': ({ folder, newWindow }, window) => this.openFolder(folder, newWindow ? undefined : window),
      'window.recentFolders': () => this.history.recentFolders(),
      'sessions.search': (request) => this.sessionSearch.search(request),
      'sessions.open': async ({ folder, sessionId }) => {
        if (!isDirectory(folder)) {
          return false;
        }
        (await this.openWindow(folder)).openConversation({ sessionId });
        return true;
      },
      'explorerMenu.get': () => this.explorerMenu.isRegistered(),
      'explorerMenu.set': async ({ enabled }) => {
        await (enabled ? this.explorerMenu.register(explorerMenuLabels()) : this.explorerMenu.unregister());
        this.logger.info(`File Explorer's context menu entries ${enabled ? 'added' : 'removed'}`);
        return this.explorerMenu.isRegistered();
      },
      'sessions.delete': async ({ sessionId }) => {
        // Its tab was just closed: the Claude process would write the transcript again as it ends.
        const started = Date.now();
        if (!(await waitForSessionEnd(this.claudeConfigDir, sessionId, SESSION_END_TIMEOUT_MS))) {
          this.logger.warn(`session ${sessionId} still runs: not deleted`);
          return 'running';
        }
        // What it cost goes into the usage ledger first (its last calls may not be read yet).
        await this.sessionSearch
          .usage({ kind: 'sync' })
          .catch((error: unknown) => this.logger.warn(`cannot keep the usage of session ${sessionId}`, error));
        const deleted = await deleteSession(this.projectsDir, sessionId);
        this.logger.info(`deleted session ${sessionId}: ${deleted.paths.length} path(s), ${Date.now() - started} ms after the request`);
        for (const window of this.windows) {
          window.sessionStoreChanged();
        }
        return deleted.transcript ? 'deleted' : 'notFound';
      },
      'sessions.fullTranscript': async ({ sessionId }, window) => {
        const id = sessionId ?? window.activeSessionId;
        if (!id) {
          return null;
        }
        const request = { sessionId: id, outDir: this.env.paths.transcriptsDir, labels: transcriptLabels() };
        return (await this.sessionSearch.fullTranscript(request)) ?? null;
      },
      'sessions.retention': () => this.keepSessions(),
      'sessions.storage': () => this.sessionSearch.storage(),
      'window.shownFolders': () => this.windows.map((window) => window.folder),
      'window.close': (_params, window) => this.requestClose(window),
      'window.openFolderAsAdministrator': ({ folder }) => this.startAdministratorInstance(folder),
      'window.reload': (_params, window) => window.reload(),
      'providers.select': ({ id }, window) => {
        if (!this.providers.get(id)) {
          throw new Error(`no provider ${id}`);
        }
        this.selectProvider(window, id);
      },
      'providers.save': ({ provider }) => this.providers.save(provider),
      'providers.remove': ({ id }) => this.providers.remove(id),
      'providers.setKey': ({ id, key }) => this.providers.setKey(id, key),
      'providers.createShortcut': ({ id }) => this.createShortcut(id),
      'sessions.reopen': async ({ sessionId }, window) => {
        // Its tab was just closed: a second Claude process on it would have to ask first.
        if (!(await waitForSessionEnd(this.claudeConfigDir, sessionId, SESSION_END_TIMEOUT_MS))) {
          this.logger.warn(`session ${sessionId} still runs: not opened again`);
          return false;
        }
        window.openConversation({ sessionId });
        return true;
      },
      'usage.models': ({ providerId }) =>
        this.sessionSearch.usage({ kind: 'models', providers: this.attributedProviders(), provider: providerId }),
      'usage.sessionCost': ({ sessionId }) => this.sessionCost(sessionId),
      'usage.total': ({ providerId }) => this.usageTotal(providerId),
      'extension.status': () => this.requireUpdater().status(),
      'extension.check': async () => this.afterInstall(await this.requireUpdater().check(true)),
      'extension.installFile': async (_params, window) => {
        const picked = await dialog.showOpenDialog(window.browserWindow, {
          title: t('installVsixTitle'),
          properties: ['openFile'],
          filters: [{ name: t('vsixFiles'), extensions: ['vsix'] }],
        });
        const file = picked.canceled ? undefined : picked.filePaths[0];
        return file ? this.afterInstall(await this.requireUpdater().installFile(file)) : { outcome: 'cancelled' };
      },
      'extension.rollBack': () => this.requireUpdater().rollBack(),
      'app.startupNotices': () => this.startupNotices(),
      'window.setKeybindings': ({ chords }, window) => window.window.setInterceptedChords(chords),
      'window.zoom': ({ delta }) => {
        // One level for all windows: Chromium zooms pages of the same origin together anyway.
        this.currentZoom = nextZoomLevel(this.currentZoom, delta);
        this.history.setZoomLevel(this.currentZoom);
        for (const window of this.windows) {
          window.window.setZoomLevel(this.currentZoom);
        }
        return this.currentZoom;
      },
      'window.setWebviewMenu': ({ webviewId, groups }, window) => window.window.setWebviewMenu(webviewId, groups),
      'window.popupMenu': ({ items }, window) =>
        new Promise<string | undefined>((resolve) => {
          let chosen: string | undefined;
          const menu = Menu.buildFromTemplate(
            items.map((item) =>
              item.id === undefined
                ? { type: 'separator' as const }
                : { label: item.label ?? '', click: () => resolve((chosen = item.id)) },
            ),
          );
          // A click may come after the menu reports it closed: give it a moment.
          menu.popup({ window: window.browserWindow, callback: () => setTimeout(() => resolve(chosen), 100) });
        }),
      'os.openPath': async ({ path: target }) => {
        const error = await shell.openPath(target);
        if (error) {
          this.logger.warn(`cannot open ${target}: ${error}`);
        }
        return !error;
      },
      'os.revealPath': ({ path: target }) => shell.showItemInFolder(target),
      'files.placeInWorkspace': ({ paths, folder, subfolder }) => placeInWorkspace(paths, folder, subfolder, this.logger),
      'os.pathKind': ({ path: target }) => {
        const stats = fs.statSync(target, { throwIfNoEntry: false });
        return stats?.isDirectory() ? 'folder' : stats?.isFile() ? 'file' : undefined;
      },
      'os.clipboardWrite': ({ text }) => clipboard.writeText(text),
      'api.status': () => this.localApi.status,
      'api.operations': ({ operations }, window) => this.localApi.setPageOperations(window.id, operations),
      'api.respond': ({ id, result, error }, window) => window.pageAnswered(id, result, error),
      'api.emit': ({ name, data }, window) => this.localApi.emit(name, { window: window.id, data }),
    };
    ipcMain.handle(IpcChannel.Rpc, async (event, method: unknown, params: unknown) => {
      if (!event.senderFrame?.url.startsWith(`${APP_ORIGIN}/`)) {
        throw new Error('Rejected IPC from an unexpected frame');
      }
      const window = this.windows.find((candidate) => candidate.webContents.id === event.sender.id);
      if (!window) {
        throw new Error('Rejected IPC from a page that is not an open window');
      }
      if (typeof method !== 'string' || !Object.hasOwn(handlers, method)) {
        throw new Error(`Unknown method ${String(method)}`);
      }
      const handler = handlers[method as keyof MainApiForRenderer] as (p: unknown, w: WindowContext) => unknown;
      return handler(params, window);
    });
    this.register(toDisposable(() => ipcMain.removeHandler(IpcChannel.Rpc)));
  }

  /**
   * After an install from the settings or the first-run page: when nothing ran before (the
   * first install), the extension starts now in every window; no restart is needed.
   */
  private async afterInstall(result: ExtensionInstallResult): Promise<ExtensionInstallResult> {
    if (result.outcome !== 'installed' || this.located) {
      return result;
    }
    const { extensionDir, ignoreOtherEditors } = this.env.args;
    const located = locateClaudeExtension(extensionDir, this.extensionStore.prepare(), !ignoreOtherEditors);
    if (located) {
      this.located = located;
      this.logger.info(`Claude Code ${located.version} installed; starting it in every window`);
      this.requireUpdater().setRunning(located);
      for (const window of this.windows) {
        window.startMissingExtensionHost();
      }
    }
    return result;
  }

  /** What the page shows once, at the first start that finds it: Git missing, say. */
  private startupNotices(): StartupNotices {
    const shown = this.shellState.get(GIT_NOTICE_KEY) === true;
    const gitMissing = !shown && findGit(process.env, isFile) === undefined;
    if (gitMissing) {
      this.shellState.set(GIT_NOTICE_KEY, true);
    }
    return { gitMissing };
  }

  /** The administrator instance on `folder`, with this instance's data folder; Windows asks first (UAC). */
  private async startAdministratorInstance(folder: string): Promise<void> {
    const appPath = app.isPackaged ? undefined : app.getAppPath();
    const result = await startElevated(process.execPath, administratorInstanceArgs(folder, appPath, this.env.args.userDataDir));
    this.logger.info(
      result.started
        ? `asked Windows to start the administrator instance on ${folder}`
        : `the administrator instance did not start: ${result.detail ?? ''}`,
    );
  }

  /** File Explorer's entries: rewritten at start when there (this program may have moved, the language changed). */
  private async refreshExplorerMenu(): Promise<void> {
    if (await this.explorerMenu.isRegistered()) {
      await this.explorerMenu.register(explorerMenuLabels());
      this.logger.info("rewrote File Explorer's context menu entries");
    }
  }

  private requireUpdater(): ExtensionUpdater {
    if (!this.updater) {
      throw new Error('the extension updater has not started');
    }
    return this.updater;
  }

  private machineId(): string {
    if (this.cachedMachineId) {
      return this.cachedMachineId;
    }
    const file = path.join(this.env.paths.root, 'machineid');
    try {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(existing)) {
        this.cachedMachineId = existing;
        return existing;
      }
    } catch {
      // First run: create one below.
    }
    const id = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, id, 'utf8');
    this.cachedMachineId = id;
    return id;
  }
}

function resolveWorkspaceFolder(folder: string | undefined, logger: ILogger): string {
  if (folder) {
    try {
      if (fs.statSync(folder).isDirectory()) {
        return folder;
      }
    } catch {
      // Fall through to the home directory.
    }
    logger.warn(`workspace folder ${folder} does not exist; using the home directory`);
  }
  return os.homedir();
}

function isDirectory(folder: string): boolean {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function stringSetting(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
