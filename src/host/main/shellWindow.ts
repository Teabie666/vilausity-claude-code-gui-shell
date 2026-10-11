/**
 * The application window: a BrowserWindow whose title bar is drawn by the renderer
 * (Windows keeps native caption buttons via titleBarOverlay). Owns the window-level
 * behaviour: navigation and popup guards, permissions, context menu, intercepted
 * keybindings, zoom, notifications and saved bounds.
 */

import {
  BrowserWindow,
  clipboard,
  type BrowserWindowConstructorOptions,
  Menu,
  Notification,
  screen,
  type MenuItemConstructorOptions,
  type MessagePortMain,
  type Rectangle,
  type WebContents,
  type WebFrameMain,
} from 'electron';
import { formatColor, parseColor } from '../../platform/accent';
import { chordFromInput } from '../../platform/keybindings';
import { Disposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import {
  AUX_WINDOW_NAME_PREFIX,
  IpcChannel,
  type ContextMenuItemDto,
  type MainEventsForRenderer,
  type ThemeData,
} from '../../platform/protocol';
import { APP_ORIGIN, CCW_SCHEME, WEBVIEW_ID_PREFIX, webviewIdFromUrl } from '../../platform/webviewUrls';
import { t } from './messages';
import type { WindowPlacement } from './windowHistory';

/** Keep in sync with --titlebar-height in the renderer stylesheet. */
export const TITLE_BAR_HEIGHT = 35;

const DEFAULT_SIZE = { width: 1280, height: 860 };

const ZOOM_STEP = 0.5;
const ZOOM_MIN = -3;
const ZOOM_MAX = 5;

/** The zoom level after `delta` steps from `current`; a delta of 0 resets. */
export function nextZoomLevel(current: number, delta: number): number {
  return delta === 0 ? 0 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current + delta * ZOOM_STEP));
}

const ALLOWED_PERMISSIONS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'notifications',
  'fullscreen',
]);

export interface ShellWindowOptions {
  readonly theme: ThemeData;
  readonly preloadPath: string;
  readonly logger: ILogger;
  readonly openDevTools: boolean;
  /** Place the window on a non-primary display (`--secondary-display`). */
  readonly secondaryDisplay: boolean;
  readonly placement: WindowPlacement;
  /** The zoom level every window shares, applied whenever the page loads. */
  readonly zoomLevel: () => number;
  readonly openExternal: (url: string) => void;
}

export function isExternalUrl(url: string): boolean {
  return /^(https?|mailto):/i.test(url);
}

/**
 * The caption buttons' overlay is transparent: the page's title bar shows under it, and so
 * does the accent line along its top edge (styles.css). Its color is still the title bar's,
 * at alpha 0: Windows' hover shade is worked out from it (light on dark, dark on light).
 */
function overlayColors(theme: ThemeData): { color: string; symbolColor: string; height: number } {
  const colors = theme.variables;
  const titleBar = parseColor(colors['vscode-titleBar-activeBackground'] ?? colors['vscode-editor-background']);
  return {
    color: `${formatColor({ ...(titleBar ?? { r: 31, g: 31, b: 31 }), a: 1 })}00`,
    symbolColor: colors['vscode-titleBar-activeForeground'] ?? '#cccccc',
    height: TITLE_BAR_HEIGHT,
  };
}

/** The webview a frame belongs to: the frame itself or its nearest `ccw://wv…` ancestor. */
function owningWebviewId(frame: WebFrameMain | null): string | undefined {
  try {
    for (let current = frame; current; current = current.parent) {
      const id = webviewIdFromUrl(current.url);
      if (id) {
        return id;
      }
    }
  } catch {
    // The frame was destroyed while the menu was being built.
  }
  return undefined;
}

/** Windows menus treat `&` as a mnemonic marker; VS Code escapes it the same way. */
function menuLabel(label: string): string {
  return process.platform === 'darwin' ? label : label.replace(/&/g, '&&');
}

/** Saved bounds are only reused if they are still mostly on a connected display. */
function visibleBounds(bounds: Rectangle | undefined): Rectangle | undefined {
  if (!bounds) {
    return undefined;
  }
  const area = screen.getDisplayMatching(bounds).workArea;
  const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
  const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
  return overlapX > 200 && overlapY > 100 ? bounds : undefined;
}

/** The size centred on the first non-primary display; undefined when there is only one. */
function onSecondaryDisplay(size: { width: number; height: number }): Rectangle | undefined {
  const primary = screen.getPrimaryDisplay().id;
  const area = screen.getAllDisplays().find((display) => display.id !== primary)?.workArea;
  if (!area) {
    return undefined;
  }
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

export class ShellWindow extends Disposable {
  readonly window: BrowserWindow;
  private interceptedChords = new Set<string>();
  /** Extra right-click menu items per webview id, as the renderer registered them. */
  private readonly webviewMenus = new Map<string, readonly (readonly ContextMenuItemDto[])[]>();
  /** Content pane tabs moved into windows of their own; the main window's page drives them. */
  private readonly auxWindows = new Set<BrowserWindow>();
  private theme: ThemeData;

  constructor(private readonly options: ShellWindowOptions) {
    super();
    this.theme = options.theme;
    const saved = visibleBounds(options.placement.bounds);
    const bounds = options.secondaryDisplay ? (onSecondaryDisplay(saved ?? DEFAULT_SIZE) ?? saved) : saved;
    this.window = new BrowserWindow({
      ...(bounds ?? DEFAULT_SIZE),
      minWidth: 640,
      minHeight: 400,
      show: false,
      title: 'Vilausity',
      backgroundColor: options.theme.variables['vscode-editor-background'] ?? '#1f1f1f',
      titleBarStyle: 'hidden',
      titleBarOverlay: overlayColors(options.theme),
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        webviewTag: false,
      },
    });
    this.installGuards();
    this.window.once('ready-to-show', () => {
      if (options.placement.maximized) {
        this.window.maximize();
      }
      this.window.show();
      if (options.openDevTools) {
        this.window.webContents.openDevTools({ mode: 'detach' });
      }
    });
    this.window.webContents.on('did-finish-load', () => {
      this.window.webContents.setZoomLevel(options.zoomLevel());
    });
    this.window.on('focus', () => this.window.flashFrame(false));
    // Auxiliary windows run on the main page's scripts: they cannot outlive it, and their
    // close handlers must not hold up quitting.
    this.window.on('closed', () => this.destroyAuxWindows());
    this.window.webContents.on('did-navigate', () => this.destroyAuxWindows());
  }

  override dispose(): void {
    this.destroyAuxWindows();
    super.dispose();
  }

  load(): Promise<void> {
    return this.window.loadURL(`${APP_ORIGIN}/index.html`);
  }

  get placement(): WindowPlacement {
    return {
      bounds: this.window.getNormalBounds(),
      maximized: this.window.isMaximized(),
    };
  }

  /** Brings the window to the front, restoring it if minimized. */
  focus(): void {
    if (this.window.isMinimized()) {
      this.window.restore();
    }
    this.window.show();
    this.window.focus();
  }

  sendExtHostPort(port: MessagePortMain): void {
    this.window.webContents.postMessage(IpcChannel.ExtHostPort, null, [port]);
  }

  emit<K extends keyof MainEventsForRenderer>(name: K, payload: MainEventsForRenderer[K]): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(IpcChannel.Event, name, payload);
    }
  }

  setTheme(theme: ThemeData): void {
    this.theme = theme;
    for (const window of [this.window, ...this.auxWindows]) {
      window.setBackgroundColor(theme.variables['vscode-editor-background'] ?? '#1f1f1f');
      window.setTitleBarOverlay(overlayColors(theme));
    }
  }

  setInterceptedChords(chords: readonly string[]): void {
    this.interceptedChords = new Set(chords);
  }

  setWebviewMenu(webviewId: string, groups: readonly (readonly ContextMenuItemDto[])[]): void {
    const nonEmpty = groups.filter((group) => group.length > 0);
    if (nonEmpty.length === 0) {
      this.webviewMenus.delete(webviewId);
    } else {
      this.webviewMenus.set(webviewId, nonEmpty);
    }
  }

  setZoomLevel(level: number): void {
    this.window.webContents.setZoomLevel(level);
    for (const aux of this.auxWindows) {
      aux.webContents.setZoomLevel(level);
    }
  }

  /** Only notifies when the window is not focused; the in-app toast covers the focused case. */
  notify(title: string, body: string): void {
    if (this.window.isFocused()) {
      return;
    }
    this.window.flashFrame(true);
    if (Notification.isSupported()) {
      const notification = new Notification({ title, body });
      notification.on('click', () => {
        if (this.window.isMinimized()) {
          this.window.restore();
        }
        this.window.focus();
      });
      notification.show();
    }
  }

  private installGuards(): void {
    const contents = this.window.webContents;
    const { openExternal } = this.options;

    contents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    contents.session.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

    contents.setWindowOpenHandler(({ url, frameName }) => {
      // The content pane opens tabs into auxiliary windows: blank pages it fills itself.
      if (url === 'about:blank' && frameName.startsWith(AUX_WINDOW_NAME_PREFIX)) {
        return { action: 'allow', overrideBrowserWindowOptions: this.auxWindowOptions() };
      }
      if (isExternalUrl(url)) {
        openExternal(url);
      }
      return { action: 'deny' };
    });
    contents.on('did-create-window', (child) => this.adoptAuxWindow(child));

    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL()) {
        event.preventDefault();
        if (isExternalUrl(url)) {
          openExternal(url);
        }
      }
    });

    this.installContentGuards(contents, this.window);

    // A reloaded renderer recreates its webviews under new ids.
    contents.on('did-navigate', () => this.webviewMenus.clear());
  }

  private auxWindowOptions(): BrowserWindowConstructorOptions {
    return {
      minWidth: 400,
      minHeight: 300,
      backgroundColor: this.theme.variables['vscode-editor-background'] ?? '#1f1f1f',
      titleBarStyle: 'hidden',
      titleBarOverlay: overlayColors(this.theme),
      autoHideMenuBar: true,
    };
  }

  private adoptAuxWindow(child: BrowserWindow): void {
    this.auxWindows.add(child);
    child.on('closed', () => this.auxWindows.delete(child));
    const contents = child.webContents;
    contents.setZoomLevel(this.window.webContents.getZoomLevel());
    // The page is written by the main window's scripts; it never navigates on its own.
    contents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (isExternalUrl(url)) {
        this.options.openExternal(url);
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternalUrl(url)) {
        this.options.openExternal(url);
      }
      return { action: 'deny' };
    });
    this.installContentGuards(contents, child);
  }

  private destroyAuxWindows(): void {
    for (const aux of [...this.auxWindows]) {
      if (!aux.isDestroyed()) {
        aux.destroy();
      }
    }
    this.auxWindows.clear();
  }

  /**
   * What every page of this window gets, the main one and auxiliary ones: webview frames
   * kept on their documents, intercepted keybindings (dispatched by the main page), the
   * context menu.
   */
  private installContentGuards(contents: WebContents, popupWindow: BrowserWindow): void {
    const { logger, openExternal } = this.options;

    // Webview iframes may only ever show their own ccw:// document.
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame) {
        return;
      }
      const url = event.url;
      if (url.startsWith(`${CCW_SCHEME}://${WEBVIEW_ID_PREFIX}`) || url === 'about:blank') {
        return;
      }
      event.preventDefault();
      logger.warn(`blocked iframe navigation to ${url}`);
      if (isExternalUrl(url)) {
        openExternal(url);
      }
    });

    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key === 'Process') {
        return;
      }
      // Developer tools stay reachable even if the renderer is broken.
      if (input.key === 'F12' || (input.control && input.shift && input.code === 'KeyI')) {
        contents.toggleDevTools();
        event.preventDefault();
        return;
      }
      const chord = chordFromInput({
        code: input.code,
        ctrl: input.control,
        shift: input.shift,
        alt: input.alt,
        meta: input.meta,
      });
      if (chord && this.interceptedChords.has(chord)) {
        event.preventDefault();
        this.emit('keybinding', { chord });
      }
    });

    contents.on('context-menu', (_event, params) => {
      // Roles keep Electron's behaviour; their built-in labels are English only.
      const template: MenuItemConstructorOptions[] = [];
      if (params.isEditable) {
        template.push(
          { role: 'undo', label: t('undo') },
          { role: 'redo', label: t('redo') },
          { type: 'separator' },
          { role: 'cut', label: t('cut') },
          { role: 'copy', label: t('copy') },
          { role: 'paste', label: t('paste') },
          { type: 'separator' },
          { role: 'selectAll', label: t('selectAll') },
        );
      } else if (params.selectionText.trim().length > 0) {
        template.push({ role: 'copy', label: t('copy') });
      }
      if (params.linkURL && isExternalUrl(params.linkURL)) {
        if (template.length > 0) {
          template.push({ type: 'separator' });
        }
        template.push(
          { label: t('openLink'), click: () => openExternal(params.linkURL) },
          { label: t('copyLink'), click: () => clipboard.writeText(params.linkURL) },
        );
      }
      // Items the renderer registered for this webview (e.g. the extension's webview/context
      // menu) come last, like VS Code puts contributed items without a group.
      const webviewId = owningWebviewId(params.frame);
      if (webviewId) {
        for (const group of this.webviewMenus.get(webviewId) ?? []) {
          if (template.length > 0) {
            template.push({ type: 'separator' });
          }
          for (const item of group) {
            template.push({
              label: menuLabel(item.label),
              click: () => this.emit('contextMenuAction', { webviewId, id: item.id }),
            });
          }
        }
      }
      if (template.length > 0) {
        Menu.buildFromTemplate(template).popup({ window: popupWindow });
      }
    });
  }
}
