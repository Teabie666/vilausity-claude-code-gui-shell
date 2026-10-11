/**
 * Implements the compatibility layer's CompatHost on top of the two RPC channels:
 * main (settings, storage, OS services, webview documents) and the renderer (UI, panels).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MessagePortMain } from 'electron';
import type { CompatHost, OutputSink } from '../../compat/vscode/host';
import { Emitter } from '../../platform/event';
import { ExtensionTranslator, translateExtensionUi } from '../../platform/extensionStrings';
import type { RpcEndpoint } from '../../platform/ipc';
import type { ILogger } from '../../platform/log';
import type {
  ExtHostApiForMain,
  ExtHostApiForRenderer,
  ExtHostInitData,
  MainApiForExtHost,
  RendererApiForExtHost,
  StorageScope,
} from '../../platform/protocol';

export type MainRpc = RpcEndpoint<ExtHostApiForMain, MainApiForExtHost, MessagePortMain>;
export type RendererRpc = RpcEndpoint<ExtHostApiForRenderer, RendererApiForExtHost, MessagePortMain>;

type ExtHostApiForRendererParams<K extends keyof ExtHostApiForRenderer> = Parameters<ExtHostApiForRenderer[K]>[0];

export interface CompatHostHandle {
  readonly host: CompatHost;
  /** Main reported that settings.json changed. */
  settingsChanged(settings: Readonly<Record<string, unknown>>, keys: readonly string[]): void;
  /** Main reported another settings overlay for this window (its API provider changed). */
  overlayChanged(values: Readonly<Record<string, unknown>>): void;
  /** Main reported a stored value another window changed. */
  storageChanged(scope: StorageScope, key: string, value: unknown): void;
  /** One of the extension's UI texts in the display language (M3.5), or as it is. */
  uiText<T extends string | undefined>(text: T): T;
}

class FileAppender implements OutputSink {
  private stream: fs.WriteStream | undefined;

  constructor(readonly filePath: string) {}

  append(text: string): void {
    if (!this.stream) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.stream = fs.createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' });
    }
    this.stream.write(text);
  }

  dispose(): void {
    this.stream?.end();
    this.stream = undefined;
  }
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'output';
}

export function createCompatHost(options: {
  readonly init: ExtHostInitData;
  readonly extensionId: string;
  readonly packageJson: Readonly<Record<string, unknown>>;
  readonly main: MainRpc;
  readonly renderer: RendererRpc;
  readonly logger: ILogger;
}): CompatHostHandle {
  const { init, main, renderer, logger } = options;

  // What the extension reads: the user's settings with the window's overlay (its API
  // provider) on top. Writes still go to the user's settings only.
  let userSettings: Readonly<Record<string, unknown>> = init.settings;
  let overlay: Readonly<Record<string, unknown>> = init.settingsOverlay ?? {};
  let settingsValues: Readonly<Record<string, unknown>> = { ...userSettings, ...overlay };
  const settingsEmitter = new Emitter<{ readonly keys: readonly string[] }>();

  // Kept current with this host's writes and other windows' changes, so a Memento created
  // late still starts from the latest values.
  const stored: Record<StorageScope, Record<string, unknown>> = {
    global: { ...init.globalState },
    workspace: { ...init.workspaceState },
  };
  const storageEmitter = new Emitter<{ scope: StorageScope; key: string; value: unknown }>();
  const storeValue = (scope: StorageScope, key: string, value: unknown): void => {
    if (value === undefined) {
      delete stored[scope][key];
    } else {
      stored[scope][key] = value;
    }
  };

  const webviewMessages = new Emitter<{ webviewId: string; message: unknown }>();
  const webviewStates = new Emitter<{ webviewId: string; state: unknown }>();
  const panelViewStates = new Emitter<{ panelId: string; active: boolean; visible: boolean }>();
  const panelCloses = new Emitter<{ panelId: string }>();
  const viewVisibility = new Emitter<{ viewId: string; visible: boolean }>();
  renderer.handle('webview.didReceiveMessage', (params) => webviewMessages.fire(params));
  renderer.handle('webview.didUpdateState', (params) => webviewStates.fire(params));
  renderer.handle('webview.didLoad', () => {});
  renderer.handle('panel.didChangeViewState', (params) => panelViewStates.fire(params));
  renderer.handle('panel.didClose', (params) => panelCloses.fire(params));
  renderer.handle('view.didChangeVisibility', (params) => viewVisibility.fire(params));

  const documentChanges = new Emitter<ExtHostApiForRendererParams<'document.didChange'>>();
  const documentDirty = new Emitter<{ uri: string; isDirty: boolean }>();
  const editorSelections = new Emitter<ExtHostApiForRendererParams<'editor.didChangeSelection'>>();
  const editorVisibility = new Emitter<ExtHostApiForRendererParams<'editor.didChangeVisible'>>();
  const tabActivations = new Emitter<{ tabId: string }>();
  const tabCloses = new Emitter<{ tabId: string }>();
  renderer.handle('document.didChange', (params) => documentChanges.fire(params));
  renderer.handle('document.didChangeDirty', (params) => documentDirty.fire(params));
  renderer.handle('editor.didChangeSelection', (params) => editorSelections.fire(params));
  renderer.handle('editor.didChangeVisible', (params) => editorVisibility.fire(params));
  renderer.handle('tab.didActivate', (params) => tabActivations.fire(params));
  renderer.handle('tab.didClose', (params) => tabCloses.fire(params));

  const reported = new Set<string>();
  const unimplementedLog = new FileAppender(path.join(init.paths.logs, 'shim-unimplemented.log'));

  // The extension's notifications, quick picks and input boxes show in the display language
  // (M3.5), as its pages do. Only what is shown changes: answers are the extension's own items.
  const translator = init.extensionTranslations ? new ExtensionTranslator(init.extensionTranslations) : undefined;
  const uiText = <T extends string | undefined>(text: T): T =>
    translator && text && translateExtensionUi(settingsValues) ? ((translator.translate(text) ?? text) as T) : text;

  const host: CompatHost = {
    logger,
    app: init.app,
    paths: init.paths,
    extension: { id: options.extensionId, path: init.extensionPath, packageJson: options.packageJson },
    workspaceFolders: init.workspaceFolders,
    themeKind: init.themeKind,

    settings: {
      get values() {
        return settingsValues;
      },
      update: (key, value) => main.call('settings.set', { key, value }),
      onDidChange: settingsEmitter.event,
    },

    storage: {
      initial: (scope) => ({ ...stored[scope] }),
      set: (scope, key, value) => {
        storeValue(scope, key, value);
        main.notify('storage.set', { scope, key, value });
      },
      onDidChange: storageEmitter.event,
    },

    os: {
      openExternal: (url) => main.call('os.openExternal', { url }),
      clipboardRead: () => main.call('os.clipboardRead', undefined),
      clipboardWrite: (text) => main.call('os.clipboardWrite', { text }),
    },

    ui: {
      showMessage: (request) =>
        renderer.call('ui.showMessage', {
          ...request,
          message: uiText(request.message),
          detail: uiText(request.detail),
          items: request.items.map(uiText),
        }),
      showQuickPick: (request) =>
        renderer.call('ui.showQuickPick', {
          ...request,
          title: uiText(request.title),
          placeHolder: uiText(request.placeHolder),
          items: request.items.map((item) => ({
            ...item,
            label: uiText(item.label),
            description: uiText(item.description),
            detail: uiText(item.detail),
          })),
        }),
      showInputBox: (request) =>
        renderer.call('ui.showInputBox', {
          ...request,
          title: uiText(request.title),
          prompt: uiText(request.prompt),
          placeHolder: uiText(request.placeHolder),
          validationMessage: uiText(request.validationMessage),
        }),
    },

    webviews: {
      setDocument: (document) => main.call('webview.setDocument', document),
      releaseDocument: (webviewId) => main.notify('webview.releaseDocument', { webviewId }),
      load: (webviewId, url) => renderer.notify('webview.load', { webviewId, url }),
      postMessage: (webviewId, message) => renderer.notify('webview.postMessage', { webviewId, message }),
      createPanel: (params) => renderer.notify('panel.create', params),
      updatePanel: (params) => renderer.notify('panel.update', params),
      revealPanel: (panelId, preserveFocus) => renderer.notify('panel.reveal', { panelId, preserveFocus }),
      disposePanel: (panelId) => renderer.notify('panel.dispose', { panelId }),
      createView: (params) => renderer.notify('view.create', params),
      updateView: (params) => renderer.notify('view.update', params),
      revealView: (viewId, preserveFocus) => renderer.notify('view.reveal', { viewId, preserveFocus }),
      disposeView: (viewId) => renderer.notify('view.dispose', { viewId }),
      onDidChangeViewVisibility: viewVisibility.event,
      onDidReceiveMessage: webviewMessages.event,
      onDidUpdateState: webviewStates.event,
      onDidChangePanelViewState: panelViewStates.event,
      onDidClosePanel: panelCloses.event,
    },

    documents: {
      applyEdits: (uri, edits) => renderer.call('document.applyEdits', { uri, edits }),
      reload: (uri, text) => renderer.notify('document.reload', { uri, text }),
      didSave: (uri) => renderer.notify('document.didSave', { uri }),
      didChangeOnDisk: (uri) => renderer.notify('document.didChangeOnDisk', { uri }),
      onDidChange: documentChanges.event,
      onDidChangeDirty: documentDirty.event,
    },

    editors: {
      showText: (params) => renderer.call('editor.showText', params),
      showDiff: (params) => renderer.call('editor.showDiff', params),
      setSelections: (editorId, selections) => renderer.notify('editor.setSelections', { editorId, selections }),
      revealRange: (editorId, range, revealType) => renderer.notify('editor.revealRange', { editorId, range, revealType }),
      closeTab: (tabId) => renderer.notify('tab.close', { tabId }),
      onDidChangeSelection: editorSelections.event,
      onDidChangeVisible: editorVisibility.event,
      onDidActivateTab: tabActivations.event,
      onDidCloseTab: tabCloses.event,
    },

    reportUnimplemented(member) {
      if (reported.has(member)) {
        return;
      }
      reported.add(member);
      logger.warn(`unimplemented VS Code API used: ${member}`);
      unimplementedLog.append(`${new Date().toISOString()} ${member}\n`);
    },

    createOutputSink: (name) => new FileAppender(path.join(init.paths.logs, 'output', `${safeFileName(name)}.log`)),
  };

  return {
    host,
    uiText,
    settingsChanged(settings, keys) {
      userSettings = settings;
      settingsValues = { ...userSettings, ...overlay };
      settingsEmitter.fire({ keys });
    },
    overlayChanged(values) {
      const keys = [...new Set([...Object.keys(overlay), ...Object.keys(values)])].filter(
        (key) => JSON.stringify(overlay[key]) !== JSON.stringify(values[key]),
      );
      overlay = values;
      settingsValues = { ...userSettings, ...overlay };
      if (keys.length > 0) {
        settingsEmitter.fire({ keys });
      }
    },
    storageChanged(scope, key, value) {
      storeValue(scope, key, value);
      storageEmitter.fire({ scope, key, value });
    },
  };
}
