/** The `vscode.workspace` namespace. vilaus has exactly one workspace folder per window. */

import * as path from 'node:path';
import type * as vscode from 'vscode';
import { Event } from '../../platform/event';
import type { ConfigurationService } from './configuration';
import type { FileSystemService } from './fileSystem';
import type { CompatHost } from './host';
import type { TextDocuments } from './textDocuments';
import { Disposable, type WorkspaceEdit } from './types';
import { Uri } from './uri';

export interface WorkspaceDependencies {
  readonly host: CompatHost;
  readonly configuration: ConfigurationService;
  readonly fileSystem: FileSystemService;
  readonly documents: TextDocuments;
}

function enabledGlobs(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([, enabled]) => enabled === true)
    .map(([glob]) => glob);
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function createWorkspaceNamespace(deps: WorkspaceDependencies): Record<string, unknown> {
  const { host, configuration, fileSystem, documents } = deps;
  const folders: vscode.WorkspaceFolder[] = host.workspaceFolders.map((folder, index) => ({
    uri: Uri.file(folder),
    name: path.basename(folder) || folder,
    index,
  }));

  const defaultExcludes = (): string[] => {
    const config = configuration.getConfiguration();
    return [...enabledGlobs(config.get('files.exclude')), ...enabledGlobs(config.get('search.exclude'))];
  };

  return {
    get workspaceFolders() {
      return folders.length > 0 ? folders : undefined;
    },
    get name() {
      return folders[0]?.name;
    },
    get rootPath() {
      return folders[0]?.uri.fsPath;
    },
    workspaceFile: undefined,
    isTrusted: true,
    onDidGrantWorkspaceTrust: Event.None,
    onDidChangeWorkspaceFolders: Event.None,

    getWorkspaceFolder: (uri: vscode.Uri) =>
      uri.scheme === 'file' ? folders.find((folder) => isInside(uri.fsPath, folder.uri.fsPath)) : undefined,

    asRelativePath: (pathOrUri: string | vscode.Uri, includeWorkspaceFolder?: boolean) => {
      const fsPath = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
      const folder = folders.find((f) => isInside(fsPath, f.uri.fsPath));
      if (!folder) {
        return fsPath;
      }
      const relative = path.relative(folder.uri.fsPath, fsPath).replace(/\\/g, '/');
      return includeWorkspaceFolder && folders.length > 1 ? `${folder.name}/${relative}` : relative;
    },

    getConfiguration: (section?: string) => configuration.getConfiguration(section),
    onDidChangeConfiguration: configuration.onDidChangeConfiguration,

    fs: fileSystem.api,
    registerFileSystemProvider: (scheme: string, provider: vscode.FileSystemProvider) => {
      const registration = fileSystem.registerProvider(scheme, provider);
      return new Disposable(() => registration.dispose());
    },
    registerTextDocumentContentProvider: (scheme: string, provider: vscode.TextDocumentContentProvider) => {
      const registration = fileSystem.registerContentProvider(scheme, provider);
      return new Disposable(() => registration.dispose());
    },
    findFiles: (include: vscode.GlobPattern, exclude?: vscode.GlobPattern | null, maxResults?: number, token?: vscode.CancellationToken) =>
      fileSystem.findFiles(include, exclude, defaultExcludes(), maxResults, token),
    createFileSystemWatcher: () => ({
      ignoreCreateEvents: false,
      ignoreChangeEvents: false,
      ignoreDeleteEvents: false,
      onDidCreate: Event.None,
      onDidChange: Event.None,
      onDidDelete: Event.None,
      dispose: () => {},
    }),

    openTextDocument: async (arg?: vscode.Uri | string | { language?: string; content?: string }) => {
      if (typeof arg === 'string') {
        return documents.open(Uri.file(arg));
      }
      if (arg && 'scheme' in arg) {
        return documents.open(arg);
      }
      return documents.openUntitled(arg?.content ?? '', arg?.language);
    },
    get textDocuments() {
      return documents.all;
    },
    onDidOpenTextDocument: documents.onDidOpen,
    onDidCloseTextDocument: documents.onDidClose,
    onDidSaveTextDocument: documents.onDidSave,
    onWillSaveTextDocument: documents.onWillSave,
    onDidChangeTextDocument: documents.onDidChange,

    applyEdit: async (edit: WorkspaceEdit) => {
      for (const [uri, edits] of edit.entries()) {
        await documents.applyTextEdits(uri, edits);
      }
      if (edit.fileOps.length > 0) {
        host.reportUnimplemented('workspace.applyEdit(file operations)');
      }
      return true;
    },
    saveAll: async () => {
      const results = await Promise.all(documents.all.filter((document) => document.isDirty).map((document) => document.save()));
      return results.every(Boolean);
    },

    onDidCreateFiles: Event.None,
    onDidDeleteFiles: Event.None,
    onDidRenameFiles: Event.None,
    onWillCreateFiles: Event.None,
    onWillDeleteFiles: Event.None,
    onWillRenameFiles: Event.None,
    notebookDocuments: [],
    onDidOpenNotebookDocument: Event.None,
    onDidCloseNotebookDocument: Event.None,
    onDidChangeNotebookDocument: Event.None,
    onDidSaveNotebookDocument: Event.None,
  };
}
