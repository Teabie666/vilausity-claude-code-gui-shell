/**
 * `workspace.fs`, `findFiles`, and the registries for extension-provided file systems
 * (`registerFileSystemProvider`) and read-only content (`registerTextDocumentContentProvider`).
 * The extension keeps its diff "proposed" documents in such providers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { IDisposable } from '../../platform/lifecycle';
import { CancellationToken } from '../../platform/cancellation';
import { FileSystemError, FileType, RelativePattern } from './types';
import { Uri } from './uri';

const FIND_FILES_TIME_BUDGET_MS = 3000;

export class FileSystemService {
  private readonly providers = new Map<string, vscode.FileSystemProvider>();
  private readonly contentProviders = new Map<string, vscode.TextDocumentContentProvider>();

  constructor(private readonly workspaceFolders: readonly string[]) {}

  registerProvider(scheme: string, provider: vscode.FileSystemProvider): IDisposable {
    this.providers.set(scheme, provider);
    return { dispose: () => this.providers.delete(scheme) };
  }

  registerContentProvider(scheme: string, provider: vscode.TextDocumentContentProvider): IDisposable {
    this.contentProviders.set(scheme, provider);
    return { dispose: () => this.contentProviders.delete(scheme) };
  }

  contentProviderFor(scheme: string): vscode.TextDocumentContentProvider | undefined {
    return this.contentProviders.get(scheme);
  }

  hasProvider(scheme: string): boolean {
    return this.providers.has(scheme);
  }

  /** The `workspace.fs` object handed to the extension. */
  readonly api: vscode.FileSystem = {
    stat: (uri) => this.stat(uri),
    readDirectory: (uri) => this.readDirectory(uri),
    createDirectory: (uri) => this.createDirectory(uri),
    readFile: (uri) => this.readFile(uri),
    writeFile: (uri, content) => this.writeFile(uri, content),
    delete: (uri, options) => this.delete(uri, options),
    rename: (source, target, options) => this.rename(source, target, options),
    copy: (source, target, options) => this.copy(source, target, options),
    isWritableFileSystem: (scheme) => {
      if (scheme === 'file') {
        return true;
      }
      return this.providers.has(scheme) ? true : undefined;
    },
  };

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const provider = this.providers.get(uri.scheme);
    if (provider) {
      return provider.stat(uri);
    }
    const stats = await wrap(uri, () => fs.promises.stat(this.fsPath(uri)));
    return {
      type: (stats.isDirectory() ? FileType.Directory : FileType.File) as unknown as vscode.FileType,
      ctime: stats.ctimeMs,
      mtime: stats.mtimeMs,
      size: stats.size,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const provider = this.providers.get(uri.scheme);
    if (provider) {
      return provider.readDirectory(uri);
    }
    const entries = await wrap(uri, () => fs.promises.readdir(this.fsPath(uri), { withFileTypes: true }));
    return entries.map((entry) => {
      const type = entry.isDirectory() ? FileType.Directory : entry.isSymbolicLink() ? FileType.SymbolicLink : FileType.File;
      return [entry.name, type as unknown as vscode.FileType];
    });
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const provider = this.providers.get(uri.scheme);
    if (provider) {
      return provider.createDirectory(uri);
    }
    await wrap(uri, () => fs.promises.mkdir(this.fsPath(uri), { recursive: true }));
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const provider = this.providers.get(uri.scheme);
    if (provider) {
      return provider.readFile(uri);
    }
    const content = this.contentProviders.get(uri.scheme);
    if (content) {
      const text = await content.provideTextDocumentContent(uri, CancellationToken.None);
      return new TextEncoder().encode(text ?? '');
    }
    return wrap(uri, () => fs.promises.readFile(this.fsPath(uri)));
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const provider = this.providers.get(uri.scheme);
    if (provider) {
      return provider.writeFile(uri, content, { create: true, overwrite: true });
    }
    const target = this.fsPath(uri);
    await wrap(uri, async () => {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content);
    });
  }

  async delete(uri: vscode.Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
    const provider = this.providers.get(uri.scheme);
    if (provider) {
      return provider.delete(uri, { recursive: options?.recursive === true });
    }
    await wrap(uri, () => fs.promises.rm(this.fsPath(uri), { recursive: options?.recursive === true }));
  }

  async rename(source: vscode.Uri, target: vscode.Uri, options?: { overwrite?: boolean }): Promise<void> {
    const provider = this.providers.get(source.scheme);
    if (provider && source.scheme === target.scheme) {
      return provider.rename(source, target, { overwrite: options?.overwrite === true });
    }
    const to = this.fsPath(target);
    if (!options?.overwrite && fs.existsSync(to)) {
      throw FileSystemError.FileExists(target);
    }
    await wrap(source, () => fs.promises.rename(this.fsPath(source), to));
  }

  async copy(source: vscode.Uri, target: vscode.Uri, options?: { overwrite?: boolean }): Promise<void> {
    const to = this.fsPath(target);
    if (!options?.overwrite && fs.existsSync(to)) {
      throw FileSystemError.FileExists(target);
    }
    await wrap(source, () => fs.promises.cp(this.fsPath(source), to, { recursive: true, force: true }));
  }

  /**
   * `workspace.findFiles`. `exclude === undefined` means "use files.exclude/search.exclude",
   * `null` means no excludes (VS Code semantics). Stops at `maxResults` or a time budget,
   * because a workspace can be the whole home directory.
   */
  async findFiles(
    include: vscode.GlobPattern,
    exclude: vscode.GlobPattern | null | undefined,
    defaultExcludes: readonly string[],
    maxResults: number | undefined,
    token: vscode.CancellationToken | undefined,
  ): Promise<vscode.Uri[]> {
    const { base, pattern } = this.resolvePattern(include);
    if (!base) {
      return [];
    }
    const excludePatterns = exclude === null ? [] : exclude === undefined ? [...defaultExcludes] : [this.resolvePattern(exclude).pattern];
    const limit = maxResults ?? Number.POSITIVE_INFINITY;
    const deadline = Date.now() + FIND_FILES_TIME_BUDGET_MS;
    const results: vscode.Uri[] = [];
    const isExcluded = (relative: string): boolean => excludePatterns.some((p) => path.matchesGlob(relative, p));

    for await (const entry of fs.promises.glob(pattern, {
      cwd: base,
      withFileTypes: true,
      exclude: (dirent) => {
        const relative = toRelative(base, path.join(dirent.parentPath, dirent.name));
        // Directory patterns look like `**/node_modules/**`; probe with a child path so the
        // whole directory is skipped instead of walked.
        return isExcluded(relative) || (dirent.isDirectory() && isExcluded(`${relative}/_`));
      },
    })) {
      if (token?.isCancellationRequested || results.length >= limit || Date.now() > deadline) {
        break;
      }
      if (entry.isFile()) {
        results.push(Uri.file(path.join(entry.parentPath, entry.name)));
      }
    }
    return results;
  }

  private resolvePattern(glob: vscode.GlobPattern): { base: string | undefined; pattern: string } {
    if (typeof glob === 'string') {
      return { base: this.workspaceFolders[0], pattern: glob };
    }
    const relative = glob as RelativePattern;
    return { base: relative.baseUri?.fsPath ?? relative.base, pattern: relative.pattern };
  }

  private fsPath(uri: vscode.Uri): string {
    if (uri.scheme !== 'file') {
      throw FileSystemError.Unavailable(`No file system provider for scheme '${uri.scheme}'`);
    }
    return uri.fsPath;
  }
}

function toRelative(base: string, fullPath: string): string {
  return path.relative(base, fullPath).replace(/\\/g, '/');
}

/** Maps Node errors to the FileSystemError codes extensions check for. */
async function wrap<T>(uri: vscode.Uri, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    switch (code) {
      case 'ENOENT':
        throw FileSystemError.FileNotFound(uri);
      case 'EEXIST':
        throw FileSystemError.FileExists(uri);
      case 'ENOTDIR':
        throw FileSystemError.FileNotADirectory(uri);
      case 'EISDIR':
        throw FileSystemError.FileIsADirectory(uri);
      case 'EACCES':
      case 'EPERM':
        throw FileSystemError.NoPermissions(uri);
      default:
        throw error;
    }
  }
}
