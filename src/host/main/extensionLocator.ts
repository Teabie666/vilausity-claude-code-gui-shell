/**
 * Finds the Claude Code extension on disk.
 *
 * Order: `--extension-dir`, then the copy vilaus manages (ExtensionStore, from Open VSX or
 * a .vsix), then the extension registries of local VSCodium / VS Code installs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compareVersions } from '../../platform/extensionUpdates';
import { readJsonFile } from '../node/jsonFile';

export const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

export interface LocatedExtension {
  readonly path: string;
  readonly version: string;
  /** Where it was found: the folder, or `--extension-dir`. */
  readonly source: string;
  /** Given with `--extension-dir`, managed by vilaus, or another editor's. */
  readonly kind: 'cli' | 'managed' | 'external';
}

interface RegistryEntry {
  identifier?: { id?: string };
  version?: string;
  location?: { fsPath?: string; path?: string };
  relativeLocation?: string;
}

/** `otherEditors: false` stops after the managed copy (tests of the first run). */
export function locateClaudeExtension(explicitDir?: string, managed?: LocatedExtension, otherEditors = true): LocatedExtension | undefined {
  if (explicitDir) {
    const version = readVersion(explicitDir);
    return version ? { path: explicitDir, version, source: '--extension-dir', kind: 'cli' } : undefined;
  }
  if (managed || !otherEditors) {
    return managed;
  }
  for (const dir of candidateExtensionDirs()) {
    const found = fromRegistry(dir) ?? fromDirectoryScan(dir);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function candidateExtensionDirs(): string[] {
  const home = os.homedir();
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const localPrograms = path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs');
  return [
    // Portable VSCodium / VS Code keep extensions next to the executable.
    path.join(programFiles, 'VSCodium', 'data', 'extensions'),
    path.join(localPrograms, 'VSCodium', 'data', 'extensions'),
    path.join(home, '.vscode-oss', 'extensions'),
    path.join(home, '.vscode', 'extensions'),
  ];
}

function fromRegistry(extensionsDir: string): LocatedExtension | undefined {
  const entries = readJsonFile<RegistryEntry[] | undefined>(path.join(extensionsDir, 'extensions.json'), undefined);
  if (!Array.isArray(entries)) {
    return undefined;
  }
  const entry = entries.find((e) => e.identifier?.id?.toLowerCase() === CLAUDE_EXTENSION_ID);
  if (!entry) {
    return undefined;
  }
  const dir = entry.relativeLocation
    ? path.join(extensionsDir, entry.relativeLocation)
    : uriPathToFsPath(entry.location?.fsPath ?? entry.location?.path);
  const version = dir ? readVersion(dir) : undefined;
  return dir && version ? { path: dir, version, source: extensionsDir, kind: 'external' } : undefined;
}

function fromDirectoryScan(extensionsDir: string): LocatedExtension | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(extensionsDir);
  } catch {
    return undefined;
  }
  const obsolete = readJsonFile<Record<string, boolean>>(path.join(extensionsDir, '.obsolete'), {});
  const candidates = names
    .filter((name) => name.toLowerCase().startsWith(`${CLAUDE_EXTENSION_ID}-`) && !obsolete[name])
    .map((name) => {
      const dir = path.join(extensionsDir, name);
      return { dir, version: readVersion(dir) };
    })
    .filter((c): c is { dir: string; version: string } => c.version !== undefined)
    .sort((a, b) => compareVersions(b.version, a.version));
  const best = candidates[0];
  return best ? { path: best.dir, version: best.version, source: extensionsDir, kind: 'external' } : undefined;
}

function readVersion(dir: string): string | undefined {
  const pkg = readJsonFile<{ version?: unknown; main?: unknown } | undefined>(path.join(dir, 'package.json'), undefined);
  if (!pkg || typeof pkg.version !== 'string' || typeof pkg.main !== 'string') {
    return undefined;
  }
  return fs.existsSync(path.join(dir, pkg.main)) ? pkg.version : undefined;
}

/** `/c:/Program Files/x` (a URI path) -> `c:\Program Files\x`. */
function uriPathToFsPath(p: string | undefined): string | undefined {
  if (!p) {
    return undefined;
  }
  const trimmed = /^\/[a-zA-Z]:/.test(p) ? p.slice(1) : p;
  return path.normalize(trimmed);
}
