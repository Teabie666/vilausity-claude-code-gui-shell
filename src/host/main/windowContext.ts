/**
 * One window and what belongs to it alone: its workspace (folders and workspace state),
 * the BrowserWindow, and the extension host that serves it. What the windows share
 * (settings, global state, theme, webview documents, the extension) stays in ShellApp,
 * which a window reaches through `WindowHost`.
 */

import * as path from 'node:path';
import { app, clipboard, dialog, MessageChannelMain, shell, type BrowserWindow, type WebContents } from 'electron';
import { Disposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import type { UiLanguage } from '../../platform/nls';
import type {
  AppInfo,
  ConversationRequest,
  ExtensionTranslations,
  ExtHostInitData,
  MainEventsForRenderer,
  ProvidersState,
  RendererInitData,
  SessionActivity,
  ThemeData,
  UsageViewDto,
} from '../../platform/protocol';
import { ENVIRONMENT_SETTING } from '../../platform/providers';
import { URI } from 'vscode-uri';
import { workspaceKey } from '../node/paths';
import type { GotoTarget } from './cli';
import type { LocatedExtension } from './extensionLocator';
import { ExtHostProcess } from './extHostProcess';
import { t } from './messages';
import type { SettingsStore } from './settingsStore';
import type { ShellEnvironment } from './shellApp';
import { ShellWindow } from './shellWindow';
import { StateStore } from './stateStore';
import type { WebviewDocumentStore } from './webviewDocuments';
import type { WindowPlacement } from './windowHistory';

const IDLE: SessionActivity = { running: 0, waiting: 0 };

/** What a window needs from the application. */
export interface WindowHost {
  readonly env: ShellEnvironment;
  readonly settings: SettingsStore;
  readonly globalState: StateStore;
  readonly documents: WebviewDocumentStore;
  readonly language: UiLanguage;
  /** The theme every window shares; a window shows it in its provider's accent (`windowTheme`). */
  readonly theme: ThemeData;
  windowTheme(providerId: string): ThemeData;
  /** The icon file of a window with this provider: the app icon in its logo's color. */
  windowIcon(providerId: string): string;
  /** The extension UI's translations in this run's language, if there are any. */
  readonly extensionTable: ExtensionTranslations | undefined;
  /** Undefined until the extension is installed: the window then has no extension host. */
  readonly extension: LocatedExtension | undefined;
  appInfo(): AppInfo;
  openExternal(url: string): Promise<boolean>;
  /** The zoom level all windows share. */
  readonly zoomLevel: number;
  /** The extension settings a provider lays over the user's (its environment variables). */
  providerOverlay(providerId: string): Record<string, unknown>;
  providersState(current: string): ProvidersState;
  /** The provider a folder's window starts with (remembered, else the default). */
  initialProvider(folder: string): string;
  /** A Claude process that started on a session at `at` under a provider made its first call. */
  tagSession(sessionId: string, providerId: string, at: number): void;
  /** Whether the shell works out what conversations under a provider cost (not the extension). */
  shellPricing(providerId: string): boolean;
  /** What the window's provider cost, for its session list (`usage.view`). */
  usageView(window: WindowContext, sessionId: string | undefined): Promise<UsageViewDto | null>;
  /** This window's extension host changed a global state value; the other windows' hosts need it too. */
  globalStateChanged(source: WindowContext, key: string, value: unknown): void;
  /** The user closed the window (its close button, Alt+F4). */
  requestClose(window: WindowContext): void;
  /** The extension activated in some window: that version works. */
  extensionActivated(version: string): void;
  /** The version to go back to when the running one fails to start, if there is one. */
  rollbackTarget(): string | undefined;
  rollBackAndRelaunch(): Promise<void>;
}

export interface WindowOptions {
  /** 1, 2, ... in the order windows open during this run; names the window's log folder. */
  readonly id: number;
  readonly folder: string;
  readonly placement: WindowPlacement;
  /** The API provider (its id). */
  readonly provider: string;
}

export class WindowContext extends Disposable {
  readonly id: number;
  readonly window: ShellWindow;
  private readonly logger: ILogger;
  private readonly logsDir: string;
  /** Marks this window's webview documents in the shared store. */
  private readonly documentOwner: string;
  private currentFolders: readonly string[] = [];
  private currentWorkspaceKey = '';
  private currentWorkspaceState: StateStore | undefined;
  private currentProvider: string;
  /** The sessions whose Claude processes started here, under which provider and when. */
  private readonly startedSessions = new Map<string, { provider: string; at: number }>();
  private extHost: ExtHostProcess | undefined;
  /** The extension host has its init data: it takes requests now. */
  private initialized = false;
  /** Requests that wait for the extension host's init. */
  private readonly afterInit: ((extHost: ExtHostProcess) => void)[] = [];
  /** Goes into the init data: opens instead of the new conversation an empty window shows. */
  private pendingConversation: ConversationRequest | undefined;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    private readonly host: WindowHost,
    options: WindowOptions,
  ) {
    super();
    const env = host.env;
    this.id = options.id;
    this.documentOwner = `window${options.id}`;
    this.logger = env.logger.child(`window${options.id}`);
    this.logsDir = env.paths.windowLogs(options.id);
    this.setWorkspace(options.folder);
    this.currentProvider = options.provider;
    this.window = this.register(
      new ShellWindow({
        theme: host.windowTheme(options.provider),
        preloadPath: path.join(env.appDir, 'preload.js'),
        iconPath: host.windowIcon(options.provider),
        logger: this.logger,
        openDevTools: env.args.devtools,
        secondaryDisplay: env.args.secondaryDisplay,
        placement: options.placement,
        zoomLevel: () => host.zoomLevel,
        openExternal: (url) => void host.openExternal(url),
      }),
    );
    if (env.paths.elevated) {
      // The taskbar and Alt+Tab say so too; the page's own title stays as it is.
      this.browserWindow.on('page-title-updated', (event, title) => {
        event.preventDefault();
        this.browserWindow.setTitle(t('administratorTitle', title));
      });
    }
    this.webContents.on('did-finish-load', () => {
      void this.startExtHost().catch((error: unknown) => this.logger.error('failed to start extension host', error));
    });
    this.browserWindow.on('close', (event) => {
      if (this.shutdownPromise) {
        return;
      }
      event.preventDefault();
      host.requestClose(this);
    });
  }

  get browserWindow(): BrowserWindow {
    return this.window.window;
  }

  get webContents(): WebContents {
    return this.window.window.webContents;
  }

  get folders(): readonly string[] {
    return this.currentFolders;
  }

  /** The workspace folder (a window has exactly one). */
  get folder(): string {
    return this.currentFolders[0] ?? '';
  }

  get workspaceKey(): string {
    return this.currentWorkspaceKey;
  }

  get workspaceState(): StateStore {
    if (!this.currentWorkspaceState) {
      throw new Error('the window has no workspace');
    }
    return this.currentWorkspaceState;
  }

  load(): Promise<void> {
    return this.window.load();
  }

  focus(): void {
    this.window.focus();
  }

  /** Opens a conversation (a session, a prompt) once the extension is up. */
  openConversation(request: ConversationRequest): void {
    if (this.extHost && this.initialized) {
      this.request(this.extHost.rpc.call('conversation.open', request), 'opening a conversation');
    } else {
      this.pendingConversation = request;
    }
  }

  /** Shows a file in the content pane, at a line (1-based) if given. */
  showFile(target: GotoTarget): void {
    const position = { line: (target.line ?? 1) - 1, character: (target.column ?? 1) - 1 };
    const selection = target.line ? { start: position, end: position } : undefined;
    this.whenInitialized((extHost) =>
      this.request(extHost.rpc.call('documents.show', { uri: URI.file(target.path).toString(), selection }), `opening ${target.path}`),
    );
  }

  /** Hands a vilaus:// link to the extension (after the user agrees). */
  openUri(uri: string): void {
    this.whenInitialized((extHost) => this.request(extHost.rpc.call('uri.handle', { uri }), `opening ${uri}`));
  }

  /**
   * Shows another folder in this window, the way VS Code reloads a window for a new
   * workspace: the extension host stops (the extension records the open conversations
   * under the old folder, so they come back with it), and the page reloads for the new
   * folder, which starts a new extension host.
   */
  async switchFolder(folder: string): Promise<void> {
    this.logger.info(`switching the workspace to ${folder}`);
    await this.stopExtHost();
    await this.workspaceState.flush();
    this.setWorkspace(folder);
    // Each folder keeps its own provider.
    this.currentProvider = this.host.initialProvider(folder);
    this.refreshIcon();
    this.webContents.reload();
  }

  /** Says so; a version installed by an update that has never worked offers going back. */
  private async activationFailed(message: string): Promise<void> {
    const target = this.host.rollbackTarget();
    if (target === undefined) {
      await dialog.showMessageBox(this.browserWindow, { type: 'error', message: t('extensionFailedToStart'), detail: message });
      return;
    }
    const { response } = await dialog.showMessageBox(this.browserWindow, {
      type: 'error',
      message: t('extensionFailedToStart'),
      detail: `${message}\n\n${t('rollBackOffer', this.host.extension?.version ?? '', target)}`,
      buttons: [t('rollBackAndRestart', target), t('close')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      await this.host.rollBackAndRelaunch();
    }
  }

  emit<K extends keyof MainEventsForRenderer>(name: K, payload: MainEventsForRenderer[K]): void {
    this.window.emit(name, payload);
  }

  rendererInitData(): RendererInitData {
    return {
      theme: this.theme,
      workspaceFolders: this.folders,
      appVersion: app.getVersion(),
      language: this.host.language,
      providers: this.host.providersState(this.currentProvider),
      elevated: this.host.env.paths.elevated,
      homeFolder: app.getPath('home'),
    };
  }

  /** The API provider (its id) this window's new conversations use. */
  get provider(): string {
    return this.currentProvider;
  }

  /**
   * Uses another provider (or the same one, edited): new conversations get its variables,
   * the ones open keep theirs until they restart (`reload`).
   */
  setProvider(id: string): void {
    this.currentProvider = id;
    this.providersChanged();
  }

  /** The providers or this window's provider changed: the page and the extension host follow, and the accent. */
  providersChanged(): void {
    if (this.extHost && this.initialized) {
      this.extHost.rpc.notify('settings.overlay', { values: this.host.providerOverlay(this.currentProvider) });
      this.extHost.rpc.notify('usage.changed', { shellPricing: this.host.shellPricing(this.currentProvider) });
    }
    this.window.emit('providersChanged', this.host.providersState(this.currentProvider));
    this.refreshTheme();
  }

  /** settings.json changed: both the page and the extension host read settings. */
  settingsChanged(keys: readonly string[]): void {
    const values = this.host.settings.all;
    this.extHost?.rpc.notify('settings.didChange', { settings: values, keys });
    this.window.emit('settingsChanged', { values, keys });
    // The provider's variables are laid over the user's own: those changed, so did the result.
    if (keys.includes(ENVIRONMENT_SETTING) && this.extHost && this.initialized) {
      this.extHost.rpc.notify('settings.overlay', { values: this.host.providerOverlay(this.currentProvider) });
    }
  }

  /** Restarts the extension host and reloads the page; the conversations come back with new Claude processes. */
  async reload(): Promise<void> {
    this.logger.info('reloading');
    await this.stopExtHost();
    await this.workspaceState.flush();
    this.webContents.reload();
  }

  /** Another window changed a global state value. */
  globalStateChanged(key: string, value: unknown): void {
    this.extHost?.rpc.notify('storage.didChange', { scope: 'global', key, value });
  }

  /** Sessions were deleted: the extension's pages list them again. */
  sessionStoreChanged(): void {
    this.extHost?.rpc.notify('sessions.storeChanged', undefined);
  }

  /** This window's theme: the shared one in its provider's accent. */
  get theme(): ThemeData {
    return this.host.windowTheme(this.currentProvider);
  }

  /** Whether the webview documents of `owner` (WebviewDocumentStore) are this window's. */
  ownsDocuments(owner: string | undefined): boolean {
    return owner === this.documentOwner;
  }

  /** The shared theme or this window's accent changed: the window and its page follow, and the icon. */
  refreshTheme(): void {
    const theme = this.theme;
    this.window.setTheme(theme);
    this.window.emit('themeChanged', theme);
    this.refreshIcon();
  }

  /** The window's icon, in its logo's color (which follows the provider, the accent and the taskbar's darkness). */
  refreshIcon(): void {
    this.window.setIcon(this.host.windowIcon(this.currentProvider));
  }

  /** The taskbar button and the page show what the conversations are doing. */
  private setActivity(activity: SessionActivity): void {
    this.window.setActivity(activity);
    this.window.emit('sessionActivity', activity);
  }

  /** After a crash (the page's restart button). */
  restartExtensionHost(): Promise<void> {
    return this.startExtHost();
  }

  /** The extension was installed for the first time while this window was open without it. */
  startMissingExtensionHost(): void {
    if (!this.extHost && !this.shutdownPromise) {
      void this.startExtHost().catch((error: unknown) => this.logger.error('failed to start extension host', error));
    }
  }

  /**
   * Stops the extension host (the extension records its open conversations and stops its
   * Claude processes) and saves the workspace state. The window stays until `destroy`.
   */
  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      await this.stopExtHost();
      await this.workspaceState.flush();
    })();
    return this.shutdownPromise;
  }

  destroy(): void {
    if (!this.browserWindow.isDestroyed()) {
      this.browserWindow.destroy();
    }
    this.extHost?.dispose();
    this.dispose();
  }

  /** Synchronous last-chance persistence for abrupt exits. */
  flushSync(): void {
    this.currentWorkspaceState?.flushSync();
  }

  private setWorkspace(folder: string): void {
    this.currentFolders = [folder];
    this.currentWorkspaceKey = workspaceKey(this.currentFolders);
    this.currentWorkspaceState = new StateStore(
      this.host.env.paths.workspaceStateFile(this.currentWorkspaceKey),
      this.logger.child('state'),
    );
  }

  private whenInitialized(action: (extHost: ExtHostProcess) => void): void {
    if (this.extHost && this.initialized) {
      action(this.extHost);
    } else {
      this.afterInit.push(action);
    }
  }

  private request(pending: Promise<unknown>, what: string): void {
    pending.catch((error: unknown) => this.logger.error(`${what} failed`, error));
  }

  private async stopExtHost(): Promise<void> {
    const previous = this.extHost;
    this.extHost = undefined;
    this.initialized = false;
    if (previous) {
      await previous.shutdown();
      previous.dispose();
    }
    this.host.documents.releaseOwner(this.documentOwner);
    // Its conversations went with it.
    this.setActivity(IDLE);
  }

  private async startExtHost(): Promise<void> {
    const extension = this.host.extension;
    if (this.shutdownPromise) {
      return;
    }
    if (!extension) {
      // The page shows the first-run page; the host starts once the extension is installed.
      this.logger.info('no Claude Code extension yet: no extension host');
      return;
    }
    if (this.extHost) {
      // The page reloaded (or the host crashed): its webviews are gone, so start from a clean host.
      this.logger.info('restarting extension host');
      await this.stopExtHost();
    }
    const extHost = await ExtHostProcess.start(path.join(this.host.env.appDir, 'exthost.js'), this.logger.child('exthost-process'));
    if (this.shutdownPromise) {
      // The window closed while the process was starting.
      await extHost.shutdown();
      extHost.dispose();
      return;
    }
    this.extHost = extHost;
    this.registerExtHostHandlers(extHost);
    extHost.onDidExit(({ expected, code }) => {
      if (!expected && !this.shutdownPromise && this.extHost === extHost) {
        // The page shows a banner with a restart button (app.restartExtensionHost).
        this.window.emit('extensionHostState', {
          state: 'crashed',
          detail: t('extensionHostExited', code ?? '?', this.logsDir),
        });
        this.setActivity(IDLE);
      }
    });

    const { port1, port2 } = new MessageChannelMain();
    await extHost.rpc.call('init', this.createInitData(extension), [port1]);
    this.window.sendExtHostPort(port2);
    this.window.emit('extensionHostState', { state: 'running' });
    this.initialized = true;
    for (const action of this.afterInit.splice(0)) {
      action(extHost);
    }
  }

  private registerExtHostHandlers(extHost: ExtHostProcess): void {
    const rpc = extHost.rpc;
    const host = this.host;
    rpc.handle('exthost.activated', ({ extensionVersion }) => {
      this.logger.info(`Claude Code ${extensionVersion} activated`);
      host.extensionActivated(extensionVersion);
    });
    rpc.handle('exthost.activationFailed', ({ message, stack }) => {
      this.logger.error(`Claude Code failed to activate: ${message}\n${stack ?? ''}`);
      void this.activationFailed(message);
    });
    rpc.handle('webview.setDocument', (document) => host.documents.set(document, this.documentOwner));
    rpc.handle('webview.releaseDocument', ({ webviewId }) => host.documents.release(webviewId));
    rpc.handle('os.openExternal', ({ url }) => host.openExternal(url));
    rpc.handle('os.clipboardRead', () => clipboard.readText());
    rpc.handle('os.clipboardWrite', ({ text }) => clipboard.writeText(text));
    rpc.handle('os.revealFile', ({ path: target }) => shell.showItemInFolder(target));
    rpc.handle('storage.set', ({ scope, key, value }) => {
      if (scope === 'workspace') {
        this.workspaceState.set(key, value);
        return;
      }
      host.globalState.set(key, value);
      host.globalStateChanged(this, key, value);
    });
    rpc.handle('settings.set', ({ key, value }) => host.settings.set(key, value));
    rpc.handle('sessions.activity', (activity) => this.setActivity(activity));
    rpc.handle('sessions.started', ({ sessionId }) => {
      this.startedSessions.set(sessionId, { provider: this.currentProvider, at: Date.now() });
    });
    rpc.handle('usage.view', ({ sessionId }) => this.host.usageView(this, sessionId));
    rpc.handle('sessions.used', ({ sessionId }) => {
      const started = this.startedSessions.get(sessionId) ?? { provider: this.currentProvider, at: Date.now() };
      this.host.tagSession(sessionId, started.provider, started.at);
    });
  }

  private createInitData(extension: LocatedExtension): ExtHostInitData {
    const paths = this.host.env.paths;
    return {
      extensionPath: extension.path,
      workspaceFolders: this.folders,
      paths: {
        userData: paths.root,
        logs: this.logsDir,
        globalStorage: paths.extensionGlobalStorage,
        workspaceStorage: paths.extensionWorkspaceStorage(this.workspaceKey),
      },
      settings: this.host.settings.all,
      globalState: this.host.globalState.snapshot,
      workspaceState: this.workspaceState.snapshot,
      logLevel: this.host.env.logLevel,
      app: this.host.appInfo(),
      themeKind: this.host.theme.kind,
      // Whatever the setting says now: the extension host follows it as it changes.
      extensionTranslations: this.host.extensionTable,
      openConversation: this.takePendingConversation(),
      settingsOverlay: this.host.providerOverlay(this.currentProvider),
      shellPricing: this.host.shellPricing(this.currentProvider),
    };
  }

  private takePendingConversation(): ConversationRequest | undefined {
    const request = this.pendingConversation;
    this.pendingConversation = undefined;
    return request;
  }
}
