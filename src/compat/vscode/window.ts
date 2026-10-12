/** The `vscode.window` namespace. */

import type * as vscode from 'vscode';
import { CancellationTokenSource } from '../../platform/cancellation';
import { Emitter, Event } from '../../platform/event';
import type { MessageSeverity, QuickPickItemDto } from '../../platform/protocol';
import type { CommandRegistry } from './commands';
import type { EditorService } from './editors';
import type { CompatHost } from './host';
import { OutputChannelImpl, asVsCodeChannel } from './outputChannels';
import type { TabGroupsModel } from './tabs';
import type { TextDocumentImpl, TextDocuments } from './textDocuments';
import { ColorThemeKind, Disposable, StatusBarAlignment } from './types';
import { Uri } from './uri';
import type { WebviewManager } from './webviews';

export interface WindowDependencies {
  readonly host: CompatHost;
  readonly commands: CommandRegistry;
  readonly tabs: TabGroupsModel;
  readonly webviews: WebviewManager;
  readonly documents: TextDocuments;
  readonly editors: EditorService;
  /** Where `outputChannel.show()` goes (the log opens in the content pane). */
  readonly onShowOutput: (channel: OutputChannelImpl) => void;
  /** Handlers from `window.registerUriHandler` (wired to the vilaus:// protocol in M4). */
  readonly uriHandlers: Set<vscode.UriHandler>;
}

type MessageItemLike = string | vscode.MessageItem;

/** `showXxxMessage(message, options?, ...items)`: the options argument is optional. */
function splitMessageArgs(args: readonly unknown[]): { options: vscode.MessageOptions; items: MessageItemLike[] } {
  const [first, ...rest] = args;
  if (typeof first === 'object' && first !== null && !('title' in first)) {
    return { options: first as vscode.MessageOptions, items: rest as MessageItemLike[] };
  }
  return { options: {}, items: args.filter((a) => a !== undefined) as MessageItemLike[] };
}

function itemLabel(item: string | vscode.QuickPickItem): QuickPickItemDto {
  if (typeof item === 'string') {
    return { label: item };
  }
  return {
    label: item.label,
    description: item.description,
    detail: item.detail,
    picked: item.picked,
    separator: (item.kind as number | undefined) === -1,
  };
}

/** `InputBoxValidationSeverity.Error`. Info and Warning messages do not block the value. */
const VALIDATION_SEVERITY_ERROR = 3;

/** What `validateInput` returned, if it rejects the value: a string, or a message with Error severity. */
function blockingValidationMessage(result: string | vscode.InputBoxValidationMessage | null | undefined): string | undefined {
  if (typeof result === 'string') {
    return result || undefined;
  }
  if (result && (result.severity as number) === VALIDATION_SEVERITY_ERROR) {
    return result.message || undefined;
  }
  return undefined;
}

export function createWindowNamespace(deps: WindowDependencies): Record<string, unknown> {
  const { host, documents, editors } = deps;

  const showMessage = async (severity: MessageSeverity, message: unknown, args: readonly unknown[]) => {
    const { options, items } = splitMessageArgs(args);
    const index = await host.ui.showMessage({
      severity,
      message: String(message),
      detail: options.detail,
      modal: options.modal === true,
      items: items.map((item) => (typeof item === 'string' ? item : item.title)),
    });
    if (index !== undefined) {
      return items[index];
    }
    // A modal dismissed with Escape resolves to its close-affordance item, like VS Code.
    return options.modal ? items.find((item) => typeof item === 'object' && item.isCloseAffordance) : undefined;
  };

  const windowStateEmitter = new Emitter<vscode.WindowState>();
  const themeEmitter = new Emitter<vscode.ColorTheme>();
  const themeKind =
    host.themeKind === 'vscode-light'
      ? ColorThemeKind.Light
      : host.themeKind === 'vscode-high-contrast'
        ? ColorThemeKind.HighContrast
        : host.themeKind === 'vscode-high-contrast-light'
          ? ColorThemeKind.HighContrastLight
          : ColorThemeKind.Dark;

  return {
    // ---- messages and pickers ----
    showInformationMessage: (message: string, ...args: unknown[]) => showMessage('info', message, args),
    showWarningMessage: (message: string, ...args: unknown[]) => showMessage('warning', message, args),
    showErrorMessage: (message: string, ...args: unknown[]) => showMessage('error', message, args),

    showQuickPick: async (
      itemsOrPromise: readonly (string | vscode.QuickPickItem)[] | Thenable<readonly (string | vscode.QuickPickItem)[]>,
      options: vscode.QuickPickOptions = {},
    ) => {
      const items = await itemsOrPromise;
      const picked = await host.ui.showQuickPick({
        items: items.map(itemLabel),
        title: options.title,
        placeHolder: options.placeHolder,
        canPickMany: options.canPickMany === true,
      });
      if (!picked) {
        return undefined;
      }
      const chosen = picked.map((index) => items[index]).filter((item) => item !== undefined);
      return options.canPickMany ? chosen : chosen[0];
    },

    showInputBox: async (options: vscode.InputBoxOptions = {}) => {
      let value = options.value;
      let validationMessage: string | undefined;
      // VS Code validates while the user types and refuses Enter on an error. The shell's
      // input box cannot call back into this process, so it asks again with the message.
      for (;;) {
        const answer = await host.ui.showInputBox({
          title: options.title,
          prompt: options.prompt,
          placeHolder: options.placeHolder,
          value,
          password: options.password === true,
          validationMessage,
        });
        if (answer === undefined || !options.validateInput) {
          return answer;
        }
        const message = blockingValidationMessage(await options.validateInput(answer));
        if (message === undefined) {
          return answer;
        }
        value = answer;
        validationMessage = message;
      }
    },

    withProgress: async <R>(
      _options: vscode.ProgressOptions,
      task: (progress: vscode.Progress<unknown>, token: vscode.CancellationToken) => Thenable<R>,
    ): Promise<R> => {
      const source = new CancellationTokenSource();
      try {
        return await task({ report: () => {} }, source.token as vscode.CancellationToken);
      } finally {
        source.dispose();
      }
    },

    setStatusBarMessage: () => new Disposable(() => {}),

    createStatusBarItem: (idOrAlignment?: string | StatusBarAlignment, alignmentOrPriority?: number) => ({
      id: typeof idOrAlignment === 'string' ? idOrAlignment : 'vilaus.statusBarItem',
      alignment: typeof idOrAlignment === 'number' ? idOrAlignment : (alignmentOrPriority ?? StatusBarAlignment.Left),
      priority: undefined,
      name: undefined,
      text: '',
      tooltip: undefined,
      color: undefined,
      backgroundColor: undefined,
      command: undefined,
      accessibilityInformation: undefined,
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),

    createOutputChannel: (name: string) => asVsCodeChannel(new OutputChannelImpl(name, host.createOutputSink(name), deps.onShowOutput)),

    // ---- webviews and tabs ----
    createWebviewPanel: (
      viewType: string,
      title: string,
      showOptions: vscode.ViewColumn | { viewColumn: vscode.ViewColumn; preserveFocus?: boolean },
      options?: vscode.WebviewPanelOptions & vscode.WebviewOptions,
    ) => deps.webviews.createWebviewPanel(viewType, title, showOptions, options),
    registerWebviewViewProvider: (viewId: string, provider: vscode.WebviewViewProvider) =>
      deps.webviews.registerViewProvider(viewId, provider),
    registerWebviewPanelSerializer: (viewType: string, serializer: vscode.WebviewPanelSerializer) =>
      deps.webviews.registerSerializer(viewType, serializer),
    tabGroups: deps.tabs,

    // ---- text editors (the content pane) ----
    get activeTextEditor() {
      return editors.activeTextEditor;
    },
    get visibleTextEditors() {
      return editors.visibleTextEditors;
    },
    onDidChangeActiveTextEditor: editors.onDidChangeActiveTextEditor,
    onDidChangeVisibleTextEditors: editors.onDidChangeVisibleTextEditors,
    onDidChangeTextEditorSelection: editors.onDidChangeTextEditorSelection,
    onDidChangeTextEditorVisibleRanges: Event.None,
    onDidChangeTextEditorOptions: Event.None,
    onDidChangeTextEditorViewColumn: Event.None,
    showTextDocument: async (
      documentOrUri: vscode.TextDocument | vscode.Uri,
      columnOrOptions?: vscode.ViewColumn | vscode.TextDocumentShowOptions,
      preserveFocus?: boolean,
    ) => {
      const document = documentOrUri instanceof Uri ? await documents.open(documentOrUri) : (documentOrUri as unknown as TextDocumentImpl);
      const options: vscode.TextDocumentShowOptions =
        typeof columnOrOptions === 'object' ? columnOrOptions : { preserveFocus: preserveFocus === true };
      return editors.showTextDocument(document, options);
    },
    createTextEditorDecorationType: () => ({ key: `decoration-${Math.random().toString(36).slice(2)}`, dispose: () => {} }),

    // ---- terminals (vilaus has none; open_terminal requests go to Windows Terminal) ----
    get terminals() {
      return [];
    },
    get activeTerminal() {
      return undefined;
    },
    createTerminal: (options?: vscode.TerminalOptions | string) => ({
      name: typeof options === 'string' ? options : (options?.name ?? 'Terminal'),
      processId: Promise.resolve(undefined),
      creationOptions: typeof options === 'object' ? options : {},
      exitStatus: undefined,
      state: { isInteractedWith: false },
      shellIntegration: undefined,
      sendText: () => host.reportUnimplemented('Terminal.sendText'),
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),
    onDidOpenTerminal: Event.None,
    onDidCloseTerminal: Event.None,
    onDidChangeActiveTerminal: Event.None,
    onDidChangeTerminalShellIntegration: Event.None,
    onDidStartTerminalShellExecution: Event.None,
    onDidEndTerminalShellExecution: Event.None,

    // ---- notebooks, window state, theme ----
    get activeNotebookEditor() {
      return undefined;
    },
    visibleNotebookEditors: [],
    onDidChangeActiveNotebookEditor: Event.None,
    onDidChangeVisibleNotebookEditors: Event.None,
    state: { focused: true, active: true },
    onDidChangeWindowState: windowStateEmitter.event,
    activeColorTheme: { kind: themeKind },
    onDidChangeActiveColorTheme: themeEmitter.event,

    registerUriHandler: (handler: vscode.UriHandler) => {
      deps.uriHandlers.add(handler);
      return new Disposable(() => deps.uriHandlers.delete(handler));
    },
  };
}
