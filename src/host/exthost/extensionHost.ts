/**
 * Loads and runs the Claude Code extension inside this utility process.
 */

import * as fs from 'node:fs';
import Module from 'node:module';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { MessagePortMain } from 'electron';
import { createVSCodeApi, type CompatServices } from '../../compat/vscode';
import { createExtensionContext } from '../../compat/vscode/extensionContext';
import { Memento } from '../../compat/vscode/memento';
import { Uri } from '../../compat/vscode/uri';
import { RpcEndpoint, type MessageTransport } from '../../platform/ipc';
import { toDisposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import type { ConversationRequest, ExtHostInitData, RangeDto, StorageScope } from '../../platform/protocol';
import { ClaudeWebviewBridge, conversationSessionId } from './bridge';
import { ConversationComments, registerCommentRequests } from './comments';
import { PanelRestore } from './panelRestore';
import { createCompatHost, type CompatHostHandle, type MainRpc, type RendererRpc } from './compatHost';
import { readContributions, translateContributions } from './contributions';
import { registerEditorRequests, showDocument } from './editorRequests';
import { installVSCodeModule } from './requireHook';
import { registerWorkbenchCommands } from './workbenchCommands';

interface ExtensionModule {
  activate?(context: vscode.ExtensionContext): unknown;
  deactivate?(): unknown;
}

/** The command the panel's "Claude Code" button runs in VS Code. */
const OPEN_CHAT_COMMAND = 'claude-vscode.editor.open';
/**
 * Opens a conversation for a session id and / or with a prompt; the extension's own
 * `/open?session=&prompt=` links use it too (checked against 2.1.282).
 */
const OPEN_CONVERSATION_COMMAND = 'claude-vscode.primaryEditor.open';

function portTransport(port: MessagePortMain): MessageTransport<MessagePortMain> {
  return {
    send: (message, transfer) => port.postMessage(message, transfer ?? []),
    listen: (handler) => {
      const listener = (event: Electron.MessageEvent): void => handler(event.data, event.ports);
      port.on('message', listener);
      port.start();
      return toDisposable(() => port.off('message', listener));
    },
  };
}

export class ExtensionHost {
  private renderer: RendererRpc | undefined;
  private compat: CompatHostHandle | undefined;
  private services: CompatServices | undefined;
  private extension: ExtensionModule | undefined;
  private context: vscode.ExtensionContext | undefined;
  private panelRestore: PanelRestore | undefined;
  private bridge: ClaudeWebviewBridge | undefined;
  private readonly rendererReady: Promise<void>;
  private markRendererReady: () => void = () => {};
  /** Settles once `activate` has run; true when it succeeded. */
  private activation: Promise<boolean> = Promise.resolve(false);
  private extensionId = '';
  private extensionName = '';
  /**
   * What to open when the extension is up, instead of a new conversation; empty when a
   * conversation was asked for separately (the window then opens none of its own).
   */
  private openAtStart: ConversationRequest | undefined;

  constructor(
    private readonly main: MainRpc,
    private readonly logger: ILogger,
  ) {
    this.rendererReady = new Promise((resolve) => {
      this.markRendererReady = resolve;
    });
  }

  initialize(init: ExtHostInitData, rendererPort: MessagePortMain): void {
    const renderer: RendererRpc = new RpcEndpoint(portTransport(rendererPort), 'exthost<->renderer', this.logger.child('rpc'));
    this.renderer = renderer;
    renderer.handle('renderer.ready', () => this.markRendererReady());
    // Extension commands and view providers only exist once activate() has run.
    renderer.handle('commands.execute', async ({ id, args }) => {
      await this.activation;
      return this.services?.commands.executeCommand(id, ...args);
    });
    renderer.handle('view.resolve', async ({ viewType }) => {
      await this.activation;
      return this.services?.webviews.resolveView(viewType) ?? false;
    });

    const packageJson = JSON.parse(fs.readFileSync(path.join(init.extensionPath, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const extensionId = `${String(packageJson.publisher)}.${String(packageJson.name)}`.toLowerCase();
    this.extensionId = extensionId;
    this.extensionName = typeof packageJson.displayName === 'string' ? packageJson.displayName : extensionId;
    this.openAtStart = init.openConversation;
    // Its settings' descriptions in the display language (the settings editor shows them).
    renderer.handle('extension.contributions', () => translateContributions(readContributions(packageJson), (text) => this.compat?.uiText(text) ?? text));

    const compat = createCompatHost({
      init,
      extensionId,
      packageJson,
      main: this.main,
      renderer,
      logger: this.logger.child('compat'),
    });
    this.compat = compat;
    const { api, services } = createVSCodeApi(compat.host, {
      // `outputChannel.show()` (the Show Logs command, the webview's open_output_panel):
      // the channel's log file opens in the content pane and follows new lines.
      onShowOutput: (channel) => void this.showLogFile(channel.filePath),
    });
    this.services = services;
    registerWorkbenchCommands(services.commands, { main: this.main, renderer });
    registerEditorRequests(renderer, services, init.workspaceFolders, this.logger.child('editors'));
    const webviews = services.webviews;
    const comments = new ConversationComments(webviews, conversationSessionId, compat.host.storage);
    registerCommentRequests(renderer, comments, this.logger.child('comments'));
    this.panelRestore = new PanelRestore(webviews, compat.host.storage, comments, this.logger.child('restore'));
    // The content pane shows `vscode.diff` (ADR 0002 held open_diff before it existed).
    const bridge = new ClaudeWebviewBridge(compat.host.os, this.logger.child('bridge'), {
      diffEditorAvailable: () => true,
      comments,
      workspaceFolders: init.workspaceFolders,
    });
    webviews.interceptor = bridge;
    this.bridge = bridge;
    renderer.handle('sessions.busy', ({ sessionId }) => bridge.sessionBusy(sessionId));
    installVSCodeModule(api);

    this.activation = this.activate(init, packageJson, compat, services);
    void this.activation.then((activated) => (activated ? this.openInitialView(services) : undefined));
  }

  settingsChanged(settings: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
    this.compat?.settingsChanged(settings, keys);
  }

  settingsOverlayChanged(values: Readonly<Record<string, unknown>>): void {
    this.compat?.overlayChanged(values);
  }

  storageChanged(scope: StorageScope, key: string, value: unknown): void {
    this.compat?.storageChanged(scope, key, value);
  }

  /** Sessions were deleted (in any window): the extension's pages list them again. */
  sessionStoreChanged(): void {
    if (this.services) {
      this.bridge?.sessionStoreChanged(this.services.webviews.allWebviews);
    }
  }

  async openConversation(request: ConversationRequest): Promise<void> {
    // It came after the init data: the window need not open a new conversation of its own.
    this.openAtStart ??= {};
    if (!(await this.ready())) {
      return;
    }
    // A session a tab shows already (the search, --session): that tab comes forward rather
    // than a second conversation on the same session.
    const shown =
      request.sessionId && !request.prompt
        ? this.services?.webviews.allPanels.find((panel) => conversationSessionId(panel.webview.state) === request.sessionId)
        : undefined;
    if (shown) {
      shown.reveal();
      return;
    }
    await this.services?.commands.executeCommand(OPEN_CONVERSATION_COMMAND, request.sessionId, request.prompt);
  }

  async showDocument(params: { uri: string; selection?: RangeDto }): Promise<boolean> {
    await this.rendererReady;
    const services = this.services;
    return services
      ? showDocument(services, { ...params, preserveFocus: false, preview: false }, this.logger.child('editors'))
      : false;
  }

  /** A `vilaus://<extension id>/...` link, for the URI handlers the extension registered; asks the user first. */
  async handleUri(uri: string): Promise<void> {
    const services = this.services;
    const renderer = this.renderer;
    if (!(await this.ready()) || !services || !renderer) {
      return;
    }
    const parsed = Uri.parse(uri);
    if (parsed.authority.toLowerCase() !== this.extensionId || services.uriHandlers.size === 0) {
      this.logger.warn(`no URI handler for ${uri}`);
      return;
    }
    if (!(await renderer.call('ui.confirmOpenUri', { uri, extensionName: this.extensionName }))) {
      return;
    }
    for (const handler of services.uriHandlers) {
      try {
        await handler.handleUri(parsed);
      } catch (error) {
        this.logger.error(`the extension failed to handle ${uri}`, error);
      }
    }
  }

  async shutdown(): Promise<void> {
    // Record the open panels before deactivate() closes them.
    this.panelRestore?.freeze();
    try {
      await this.extension?.deactivate?.();
    } catch (error) {
      this.logger.error('extension deactivate failed', error);
    }
    for (const subscription of this.context?.subscriptions ?? []) {
      try {
        subscription.dispose();
      } catch (error) {
        this.logger.warn('disposing an extension subscription failed', error);
      }
    }
    this.services?.webviews.dispose();
    this.services?.documents.dispose();
    this.renderer?.dispose();
  }

  private async activate(
    init: ExtHostInitData,
    packageJson: Record<string, unknown>,
    compat: CompatHostHandle,
    services: CompatServices,
  ): Promise<boolean> {
    const version = String(packageJson.version);
    try {
      const mainFile = path.join(init.extensionPath, String(packageJson.main ?? 'extension.js'));
      const load = Module.createRequire(mainFile);
      this.extension = load(mainFile) as ExtensionModule;
      const context = createExtensionContext(
        compat.host,
        new Memento('global', compat.host.storage),
        new Memento('workspace', compat.host.storage),
        services.extensionObject,
      );
      this.context = context;
      const started = Date.now();
      const exports = await this.extension.activate?.(context);
      services.setExtensionExports(exports);
      this.logger.info(`activated Claude Code ${version} in ${Date.now() - started} ms`);
      this.main.notify('exthost.activated', { extensionVersion: version });
      return true;
    } catch (error) {
      this.logger.error('activation failed', error);
      const err = error instanceof Error ? error : new Error(String(error));
      this.main.notify('exthost.activationFailed', { message: err.message, stack: err.stack });
      return false;
    }
  }

  private async showLogFile(filePath: string): Promise<void> {
    const services = this.services;
    if (!services) {
      return;
    }
    try {
      // The channel creates its file on the first line it writes.
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.appendFile(filePath, '');
      const document = await services.documents.open(Uri.file(filePath));
      await services.editors.showTextDocument(document, { preview: false });
    } catch (error) {
      this.logger.error(`cannot show the log ${filePath}`, error);
    }
  }

  private async openInitialView(services: CompatServices): Promise<void> {
    await this.rendererReady;
    const restored = (await this.panelRestore?.restore()) ?? 0;
    const requested = this.openAtStart;
    if (requested?.sessionId || requested?.prompt) {
      await services.commands.executeCommand(OPEN_CONVERSATION_COMMAND, requested.sessionId, requested.prompt);
    } else if (!requested && restored === 0 && services.webviews.allPanels.length === 0) {
      await services.commands.executeCommand(OPEN_CHAT_COMMAND);
    }
  }

  /** Resolves once the extension is active and the renderer can show its panels; false if activation failed. */
  private async ready(): Promise<boolean> {
    const activated = await this.activation;
    await this.rendererReady;
    return activated;
  }
}
