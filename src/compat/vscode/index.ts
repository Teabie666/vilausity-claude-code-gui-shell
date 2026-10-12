/**
 * Assembles the `vscode` module object the Claude Code extension `require`s.
 *
 * Shape: a plain object holding the classes, enums and namespaces we implement, whose
 * prototype is a stub-reporting proxy (see catchAll.ts). Namespaces are wrapped the
 * same way, so an API member we lack degrades to a logged no-op instead of a crash.
 */

import * as path from 'node:path';
import type * as vscode from 'vscode';
import { CancellationError, CancellationTokenSource } from '../../platform/cancellation';
import { Emitter, Event } from '../../platform/event';
import { createStubPrototype, withStubs } from './catchAll';
import { CommandRegistry } from './commands';
import { ConfigurationService, defaultsFromPackageJson } from './configuration';
import { EditorService } from './editors';
import { createExtensionObject, type ExtensionObject } from './extensionContext';
import { FileSystemService } from './fileSystem';
import type { CompatHost } from './host';
import type { OutputChannelImpl } from './outputChannels';
import { TabGroupsModel } from './tabs';
import { TextDocuments } from './textDocuments';
import * as types from './types';
import { Uri } from './uri';
import { WebviewManager } from './webviews';
import { createWindowNamespace } from './window';
import { createWorkspaceNamespace } from './workspace';

/** The VS Code EventEmitter class: our Emitter already has the right shape. */
export class EventEmitter<T> extends Emitter<T> {}

export interface CompatHooks {
  readonly onShowOutput: (channel: OutputChannelImpl) => void;
}

/** Internals the extension host needs (to open panels, restore them, intercept messages...). */
export interface CompatServices {
  readonly commands: CommandRegistry;
  readonly configuration: ConfigurationService;
  readonly tabs: TabGroupsModel;
  readonly webviews: WebviewManager;
  readonly documents: TextDocuments;
  readonly editors: EditorService;
  readonly fileSystem: FileSystemService;
  readonly uriHandlers: Set<vscode.UriHandler>;
  /** Set once the extension module is loaded, so `extensions.getExtension(...).exports` works. */
  setExtensionExports(exports: unknown): void;
  readonly extensionObject: ExtensionObject;
}

export interface CompatApi {
  readonly api: object;
  readonly services: CompatServices;
}

function showOptionsFrom(value: unknown): vscode.TextDocumentShowOptions {
  if (typeof value === 'object' && value !== null) {
    return value as vscode.TextDocumentShowOptions;
  }
  return {};
}

/** Built-in commands that open editors: `vscode.open` and `vscode.diff`. */
function registerEditorCommands(commands: CommandRegistry, documents: TextDocuments, editors: EditorService, host: CompatHost): void {
  commands.registerBuiltin('vscode.open', async (resource, columnOrOptions) => {
    const uri = typeof resource === 'string' ? Uri.parse(resource) : (resource as vscode.Uri);
    if (uri.scheme === 'http' || uri.scheme === 'https' || uri.scheme === 'mailto') {
      await host.os.openExternal(uri.toString(true));
      return;
    }
    const document = await documents.open(uri);
    await editors.showTextDocument(document, showOptionsFrom(columnOrOptions));
  });
  const toUri = (value: unknown): vscode.Uri => (typeof value === 'string' ? Uri.parse(value) : (value as vscode.Uri));
  commands.registerBuiltin('vscode.diff', async (left, right, title, options) => {
    const [original, modified] = await Promise.all([documents.open(toUri(left)), documents.open(toUri(right))]);
    const label = typeof title === 'string' && title ? title : `${original.fileName} ↔ ${modified.fileName}`;
    await editors.openDiff(original, modified, label, showOptionsFrom(options));
  });
}

function formatL10n(message: string, args: readonly unknown[]): string {
  const values = args.length === 1 && typeof args[0] === 'object' && args[0] !== null ? (args[0] as Record<string, unknown>) : args;
  return message.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = (values as Record<string, unknown>)[key];
    // As VS Code's l10n formats whatever it is handed.
    // oxlint-disable-next-line typescript/no-base-to-string
    return value === undefined ? match : String(value);
  });
}

export function createVSCodeApi(host: CompatHost, hooks: CompatHooks): CompatApi {
  const report = (member: string): void => host.reportUnimplemented(member);

  const commands = new CommandRegistry(host.logger.child('commands'), report);
  const configuration = new ConfigurationService(host.settings, defaultsFromPackageJson(host.extension.packageJson));
  const tabs = new TabGroupsModel();
  const webviews = new WebviewManager(host, tabs);
  const fileSystem = new FileSystemService(host.workspaceFolders);
  const documents = new TextDocuments(fileSystem, host.documents);
  const editors = new EditorService(host.editors, tabs, documents, host.logger.child('editors'));
  const uriHandlers = new Set<vscode.UriHandler>();
  registerEditorCommands(commands, documents, editors, host);

  let extensionExports: unknown;
  const extensionObject = createExtensionObject(host, () => extensionExports);

  const window = createWindowNamespace({
    host,
    commands,
    tabs,
    webviews,
    documents,
    editors,
    onShowOutput: hooks.onShowOutput,
    uriHandlers,
  });
  const workspace = createWorkspaceNamespace({ host, configuration, fileSystem, documents });

  const logLevelEmitter = new Emitter<types.LogLevel>();
  const env = {
    appName: host.app.appName,
    appRoot: path.dirname(process.execPath),
    appHost: 'desktop',
    uriScheme: host.app.uriScheme,
    language: host.app.language,
    machineId: host.app.machineId,
    sessionId: host.app.sessionId,
    shell: host.app.shell,
    uiKind: types.UIKind.Desktop,
    remoteName: undefined,
    isNewAppInstall: false,
    isTelemetryEnabled: false,
    onDidChangeTelemetryEnabled: Event.None,
    onDidChangeShell: Event.None,
    logLevel: types.LogLevel.Info,
    onDidChangeLogLevel: logLevelEmitter.event,
    clipboard: {
      readText: () => host.os.clipboardRead(),
      writeText: (text: string) => host.os.clipboardWrite(text),
    },
    // Unencoded form keeps query strings (e.g. OAuth `scope=a+b`) exactly as the extension built them.
    openExternal: (target: vscode.Uri) => host.os.openExternal(target.toString(true)),
    asExternalUri: (target: vscode.Uri) => Promise.resolve(target),
  };

  const extensions = {
    getExtension: (id: string) => (id.toLowerCase() === host.extension.id ? extensionObject : undefined),
    get all() {
      return [extensionObject];
    },
    onDidChange: Event.None,
  };

  const languages = {
    // vilaus runs no language servers: no diagnostics, for one file or for all.
    getDiagnostics: () => [],
    onDidChangeDiagnostics: Event.None,
    getLanguages: () => Promise.resolve(['plaintext', 'markdown', 'typescript', 'javascript', 'python', 'json']),
  };

  const comments = {
    createCommentController: (id: string, label: string) => ({
      id,
      label,
      options: undefined,
      commentingRangeProvider: undefined,
      reactionHandler: undefined,
      createCommentThread: (uri: vscode.Uri, range: vscode.Range, threadComments: readonly vscode.Comment[]) => ({
        uri,
        range,
        comments: threadComments,
        collapsibleState: types.CommentThreadCollapsibleState.Collapsed,
        canReply: false,
        contextValue: undefined,
        label: undefined,
        state: types.CommentThreadState.Unresolved,
        dispose: () => {},
      }),
      dispose: () => {},
    }),
  };

  const commandsNamespace = {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown, thisArg?: unknown) =>
      commands.registerCommand(id, handler, thisArg),
    registerTextEditorCommand: (id: string, handler: (...args: unknown[]) => unknown, thisArg?: unknown) =>
      commands.registerCommand(id, handler, thisArg),
    executeCommand: (id: string, ...args: unknown[]) => commands.executeCommand(id, ...args),
    getCommands: (filterInternal?: boolean) => commands.getCommands(filterInternal),
  };

  const ns = <T extends object>(value: T, name: string): T => withStubs(value, `vscode.${name}`, report);

  const api = Object.create(createStubPrototype('vscode', report)) as Record<string, unknown>;
  Object.assign(api, {
    version: host.app.vscodeVersion,
    // value types and enums
    ...types,
    Uri,
    EventEmitter,
    CancellationTokenSource,
    CancellationError,
    // namespaces
    commands: ns(commandsNamespace, 'commands'),
    window: ns(window, 'window'),
    workspace: ns(workspace, 'workspace'),
    env: ns(env, 'env'),
    extensions: ns(extensions, 'extensions'),
    languages: ns(languages, 'languages'),
    comments: ns(comments, 'comments'),
    l10n: ns({ t: (message: string, ...args: unknown[]) => formatL10n(message, args), bundle: undefined, uri: undefined }, 'l10n'),
    debug: ns({}, 'debug'),
    tasks: ns({}, 'tasks'),
    scm: ns({}, 'scm'),
    notebooks: ns({}, 'notebooks'),
    authentication: ns({}, 'authentication'),
    lm: ns({}, 'lm'),
    chat: ns({}, 'chat'),
    tests: ns({}, 'tests'),
  });

  return {
    api,
    services: {
      commands,
      configuration,
      tabs,
      webviews,
      documents,
      editors,
      fileSystem,
      uriHandlers,
      extensionObject,
      setExtensionExports: (exports) => {
        extensionExports = exports;
      },
    },
  };
}
