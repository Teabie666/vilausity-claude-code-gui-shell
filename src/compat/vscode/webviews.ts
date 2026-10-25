/**
 * Webviews: `createWebviewPanel`, `registerWebviewViewProvider`, `registerWebviewPanelSerializer`.
 *
 * A Webview here is a handle; its document lives in the renderer as an iframe served by
 * main from `ccw://<webviewId>/`. Setting `html` registers the document with main and then
 * asks the renderer to (re)load the iframe.
 */

import type * as vscode from 'vscode';
import { CancellationToken } from '../../platform/cancellation';
import { Emitter, type Event } from '../../platform/event';
import { generateId } from '../../platform/ids';
import type { IDisposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import type { IconPathDto, PanelArea, WebviewPageHints } from '../../platform/protocol';
import { WEBVIEW_CSP_SOURCE, WEBVIEW_ID_PREFIX, resourceUrlForFsPath, webviewDocumentUrl } from '../../platform/webviewUrls';
import type { CompatHost, WebviewBackend } from './host';
import type { TabGroupsModel, TabImpl } from './tabs';
import { TabInputWebview, ThemeIcon, ViewColumn } from './types';
import { Uri } from './uri';

/** Lets the extension host see messages before the extension does (host/exthost/bridge.ts). */
export interface WebviewMessageInterceptor {
  /**
   * Returns true when the message was handled and must not reach the extension. It may
   * also rewrite the message in place and return false to pass it on changed.
   */
  interceptFromWebview(webview: WebviewImpl, message: unknown): boolean;
  /**
   * Sees what the extension posts to a webview. It may return a message to post in its place:
   * a changed copy, never the message itself changed (the extension may post one object to
   * several pages). Undefined posts the message as it is; null drops it.
   */
  observeToWebview?(webview: WebviewImpl, message: unknown): unknown;
  /** The webview is gone with its panel or view. */
  didDisposeWebview?(webview: WebviewImpl): void;
  /** What the shell's script in this webview should know about the page (asked once per webview). */
  pageHints?(webview: WebviewImpl): WebviewPageHints | undefined;
  /** Whether a panel being created for this webview opens as a preview (see `PanelCreateParams.preview`). */
  opensAsPreview?(webview: WebviewImpl): boolean;
}

type IconPath = vscode.Uri | { readonly light: vscode.Uri; readonly dark: vscode.Uri } | ThemeIcon;

export class WebviewImpl implements vscode.Webview {
  private htmlValue = '';
  private generation = 0;
  private disposed = false;
  /** Last `setState` from the page; restored into `getState()` when the document reloads. */
  state: unknown = undefined;
  /** Passed to the shell's script in the page with every document. */
  pageHints: WebviewPageHints | undefined = undefined;
  /** Sees each message the extension posts (the manager hands them to its interceptor), maybe a replacement (null: none). */
  onPost: ((message: unknown) => unknown) | undefined = undefined;
  private readonly messageEmitter = new Emitter<unknown>();
  readonly onDidReceiveMessage: Event<unknown> = this.messageEmitter.event;

  constructor(
    readonly id: string,
    readonly viewType: string,
    public options: vscode.WebviewOptions,
    private readonly backend: WebviewBackend,
    private readonly extensionPath: string,
    private readonly logger: ILogger,
  ) {}

  get html(): string {
    return this.htmlValue;
  }

  set html(value: string) {
    this.htmlValue = value;
    void this.render().catch((error: unknown) => this.logger.error(`failed to render webview ${this.id}`, error));
  }

  get cspSource(): string {
    return WEBVIEW_CSP_SOURCE;
  }

  asWebviewUri(resource: vscode.Uri): vscode.Uri {
    if (resource.scheme !== 'file') {
      return resource;
    }
    return Uri.parse(resourceUrlForFsPath(resource.fsPath));
  }

  postMessage(message: unknown): Thenable<boolean> {
    if (this.disposed) {
      return Promise.resolve(false);
    }
    const replacement = this.onPost?.(message);
    if (replacement === null) {
      return Promise.resolve(true);
    }
    // MessagePort delivery is ordered, so resolving right away keeps the extension's
    // send queue moving without a round trip per message.
    this.backend.postMessage(this.id, replacement === undefined ? message : replacement);
    return Promise.resolve(true);
  }

  /** Called by the manager for messages that passed the interceptor. */
  deliverFromWebview(message: unknown): void {
    this.messageEmitter.fire(message);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.backend.releaseDocument(this.id);
    this.messageEmitter.dispose();
  }

  private async render(): Promise<void> {
    const generation = ++this.generation;
    const roots = (this.options.localResourceRoots ?? []).map((root) => root.fsPath);
    await this.backend.setDocument({
      webviewId: this.id,
      html: this.htmlValue,
      resourceRoots: [...roots, this.extensionPath],
      state: this.state,
      hints: this.pageHints,
    });
    if (generation === this.generation && !this.disposed) {
      this.backend.load(this.id, webviewDocumentUrl(this.id, generation));
    }
  }
}

export class WebviewPanelImpl implements vscode.WebviewPanel {
  private titleValue: string;
  private iconValue: IconPath | undefined;
  private activeValue = false;
  private visibleValue = false;
  private disposed = false;
  private readonly disposeEmitter = new Emitter<void>();
  readonly onDidDispose: Event<void> = this.disposeEmitter.event;
  private readonly viewStateEmitter = new Emitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
  readonly onDidChangeViewState: Event<vscode.WebviewPanelOnDidChangeViewStateEvent> = this.viewStateEmitter.event;
  readonly tab: TabImpl;

  constructor(
    readonly id: string,
    readonly viewType: string,
    title: string,
    readonly area: PanelArea,
    readonly webview: WebviewImpl,
    readonly options: vscode.WebviewPanelOptions,
    private readonly backend: WebviewBackend,
    private readonly tabs: TabGroupsModel,
    private readonly onDisposed: (panel: WebviewPanelImpl) => void,
  ) {
    this.titleValue = title;
    // VS Code reports panel tabs with this viewType prefix; the extension matches on it.
    this.tab = tabs.add(area, title, new TabInputWebview(`mainThreadWebview-${viewType}`), () => this.dispose());
  }

  get title(): string {
    return this.titleValue;
  }

  set title(value: string) {
    this.titleValue = value;
    this.tabs.setLabel(this.tab, value);
    this.backend.updatePanel({ panelId: this.id, title: value });
  }

  get iconPath(): IconPath | undefined {
    return this.iconValue;
  }

  set iconPath(value: IconPath | undefined) {
    this.iconValue = value;
    this.backend.updatePanel({ panelId: this.id, iconPath: toIconDto(value) ?? null });
  }

  get viewColumn(): vscode.ViewColumn {
    return this.tab.group.viewColumn as unknown as vscode.ViewColumn;
  }

  get active(): boolean {
    return this.activeValue;
  }

  get visible(): boolean {
    return this.visibleValue;
  }

  reveal(_viewColumn?: vscode.ViewColumn, preserveFocus?: boolean): void {
    if (!this.disposed) {
      this.backend.revealPanel(this.id, preserveFocus === true);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.backend.disposePanel(this.id);
    this.tabs.remove(this.tab);
    this.webview.dispose();
    this.onDisposed(this);
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
    this.viewStateEmitter.dispose();
  }

  /** Renderer reported a visibility/focus change. */
  setViewState(active: boolean, visible: boolean): void {
    if (this.disposed || (active === this.activeValue && visible === this.visibleValue)) {
      return;
    }
    this.activeValue = active;
    this.visibleValue = visible;
    if (active) {
      this.tabs.setActive(this.tab);
    }
    this.viewStateEmitter.fire({ webviewPanel: this });
  }
}

/** A webview shown in a shell region (the sidebar), from `registerWebviewViewProvider`. */
export class WebviewViewImpl implements vscode.WebviewView {
  private titleValue: string | undefined;
  private descriptionValue: string | undefined;
  private badgeValue: vscode.ViewBadge | undefined;
  private visibleValue = true;
  private disposed = false;
  private readonly visibilityEmitter = new Emitter<void>();
  readonly onDidChangeVisibility: Event<void> = this.visibilityEmitter.event;
  private readonly disposeEmitter = new Emitter<void>();
  readonly onDidDispose: Event<void> = this.disposeEmitter.event;

  constructor(
    readonly id: string,
    readonly viewType: string,
    readonly webview: WebviewImpl,
    private readonly backend: WebviewBackend,
    private readonly onDisposed: (view: WebviewViewImpl) => void,
  ) {}

  get title(): string | undefined {
    return this.titleValue;
  }

  set title(value: string | undefined) {
    this.titleValue = value;
    this.backend.updateView({ viewId: this.id, title: value ?? '' });
  }

  get description(): string | undefined {
    return this.descriptionValue;
  }

  set description(value: string | undefined) {
    this.descriptionValue = value;
    this.backend.updateView({ viewId: this.id, description: value ?? '' });
  }

  get badge(): vscode.ViewBadge | undefined {
    return this.badgeValue;
  }

  set badge(value: vscode.ViewBadge | undefined) {
    this.badgeValue = value;
    this.backend.updateView({ viewId: this.id, badge: value?.value ?? 0 });
  }

  get visible(): boolean {
    return this.visibleValue;
  }

  show(preserveFocus?: boolean): void {
    if (!this.disposed) {
      this.backend.revealView(this.id, preserveFocus === true);
    }
  }

  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visibleValue) {
      return;
    }
    this.visibleValue = visible;
    this.visibilityEmitter.fire();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.backend.disposeView(this.id);
    this.webview.dispose();
    this.onDisposed(this);
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
    this.visibilityEmitter.dispose();
  }
}

export function toIconDto(icon: IconPath | undefined): IconPathDto | undefined {
  if (!icon || icon instanceof ThemeIcon) {
    return undefined;
  }
  const toUrl = (uri: vscode.Uri): string => (uri.scheme === 'file' ? resourceUrlForFsPath(uri.fsPath) : uri.toString());
  if ('light' in icon && 'dark' in icon) {
    return { light: toUrl(icon.light), dark: toUrl(icon.dark) };
  }
  const url = toUrl(icon as vscode.Uri);
  return { light: url, dark: url };
}

interface ShowOptions {
  readonly viewColumn?: vscode.ViewColumn;
  readonly preserveFocus?: boolean;
}

/** The chat panel's viewType (anthropic.claude-code 2.1.282): always the conversation area. */
export const CHAT_PANEL_VIEW_TYPE = 'claudeVSCodePanel';

/**
 * The first editor column is the conversation area; any column beside it is the content
 * pane. The extension opens its plan preview at "chat column + 1", which lands it there.
 */
export function panelAreaFor(viewType: string, showOptions: vscode.ViewColumn | ShowOptions | undefined): PanelArea {
  if (viewType === CHAT_PANEL_VIEW_TYPE) {
    return 'main';
  }
  const column = typeof showOptions === 'object' ? showOptions.viewColumn : showOptions;
  return (column as number | undefined) === ViewColumn.Beside || ((column as number | undefined) ?? 0) >= ViewColumn.Two ? 'side' : 'main';
}

export class WebviewManager implements IDisposable {
  private readonly panels = new Map<string, WebviewPanelImpl>();
  /** Resolved views, by viewType (each view type is shown at most once). */
  private readonly views = new Map<string, WebviewViewImpl>();
  private readonly webviews = new Map<string, WebviewImpl>();
  private readonly subscriptions: IDisposable[] = [];
  readonly serializers = new Map<string, vscode.WebviewPanelSerializer>();
  readonly viewProviders = new Map<string, vscode.WebviewViewProvider>();
  interceptor: WebviewMessageInterceptor | undefined;
  private readonly panelsEmitter = new Emitter<void>();
  /** A panel was created or disposed, or a panel's webview state changed. */
  readonly onDidChangePanels: Event<void> = this.panelsEmitter.event;

  constructor(
    private readonly host: CompatHost,
    private readonly tabs: TabGroupsModel,
  ) {
    const backend = host.webviews;
    this.subscriptions.push(
      backend.onDidReceiveMessage(({ webviewId, message }) => {
        const webview = this.webviews.get(webviewId);
        if (!webview) {
          return;
        }
        if (this.interceptor?.interceptFromWebview(webview, message)) {
          return;
        }
        webview.deliverFromWebview(message);
      }),
      backend.onDidUpdateState(({ webviewId, state }) => {
        const webview = this.webviews.get(webviewId);
        if (webview) {
          webview.state = state;
          this.panelsEmitter.fire();
        }
      }),
      backend.onDidChangePanelViewState(({ panelId, active, visible }) => {
        this.panels.get(panelId)?.setViewState(active, visible);
      }),
      backend.onDidClosePanel(({ panelId }) => this.panels.get(panelId)?.dispose()),
      backend.onDidChangeViewVisibility(({ viewId, visible }) => {
        for (const view of this.views.values()) {
          if (view.id === viewId) {
            view.setVisible(visible);
          }
        }
      }),
    );
  }

  /**
   * Shows the view registered under `viewType`, resolving it through the extension's
   * provider the first time. Returns false when no provider is registered.
   */
  resolveView(viewType: string): boolean {
    const existing = this.views.get(viewType);
    if (existing) {
      existing.show(true);
      return true;
    }
    const provider = this.viewProviders.get(viewType);
    if (!provider) {
      return false;
    }
    const viewId = generateId('view');
    const webview = this.createWebview(viewType, {});
    const webviewId = webview.id;
    const view = new WebviewViewImpl(viewId, viewType, webview, this.host.webviews, (disposed) => {
      this.views.delete(disposed.viewType);
      this.webviews.delete(disposed.webview.id);
      this.interceptor?.didDisposeWebview?.(disposed.webview);
    });
    this.views.set(viewType, view);
    this.host.webviews.createView({ viewId, webviewId, viewType });
    void Promise.resolve(provider.resolveWebviewView(view, { state: undefined }, CancellationToken.None)).catch((error: unknown) =>
      this.host.logger.error(`resolving view ${viewType} failed`, error),
    );
    return true;
  }

  get allPanels(): readonly WebviewPanelImpl[] {
    return [...this.panels.values()];
  }

  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions: vscode.ViewColumn | ShowOptions | undefined,
    options: vscode.WebviewPanelOptions & vscode.WebviewOptions = {},
  ): WebviewPanelImpl {
    const panelId = generateId('panel');
    const preserveFocus = typeof showOptions === 'object' && showOptions.preserveFocus === true;
    const area = panelAreaFor(viewType, showOptions);
    const webview = this.createWebview(viewType, options);
    const webviewId = webview.id;
    const panel = new WebviewPanelImpl(panelId, viewType, title, area, webview, options, this.host.webviews, this.tabs, (disposed) => {
      this.panels.delete(disposed.id);
      this.webviews.delete(disposed.webview.id);
      this.interceptor?.didDisposeWebview?.(disposed.webview);
      this.panelsEmitter.fire();
    });
    this.panels.set(panelId, panel);
    this.panelsEmitter.fire();
    const preview = this.interceptor?.opensAsPreview?.(webview) === true;
    this.host.webviews.createPanel({
      panelId,
      webviewId,
      viewType,
      title,
      area,
      preserveFocus,
      retainContextWhenHidden: options.retainContextWhenHidden === true,
      enableFindWidget: options.enableFindWidget === true,
      ...(preview ? { preview } : {}),
    });
    return panel;
  }

  private createWebview(viewType: string, options: vscode.WebviewOptions): WebviewImpl {
    const webview = new WebviewImpl(
      generateId(WEBVIEW_ID_PREFIX),
      viewType,
      options,
      this.host.webviews,
      this.host.extension.path,
      this.host.logger.child('webview'),
    );
    // Before the extension sets any html: every document of this webview carries them.
    webview.pageHints = this.interceptor?.pageHints?.(webview);
    webview.onPost = (message) => this.interceptor?.observeToWebview?.(webview, message);
    this.webviews.set(webview.id, webview);
    return webview;
  }

  /** Every live webview: panels' and views'. */
  get allWebviews(): readonly WebviewImpl[] {
    return [...this.webviews.values()];
  }

  registerSerializer(viewType: string, serializer: vscode.WebviewPanelSerializer): IDisposable {
    this.serializers.set(viewType, serializer);
    return { dispose: () => this.serializers.delete(viewType) };
  }

  registerViewProvider(viewId: string, provider: vscode.WebviewViewProvider): IDisposable {
    this.viewProviders.set(viewId, provider);
    return { dispose: () => this.viewProviders.delete(viewId) };
  }

  dispose(): void {
    for (const panel of [...this.panels.values()]) {
      panel.dispose();
    }
    for (const view of [...this.views.values()]) {
      view.dispose();
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}
