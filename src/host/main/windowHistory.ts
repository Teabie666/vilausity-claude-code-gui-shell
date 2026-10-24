/**
 * What main remembers about windows between runs (state/shell.json, apart from the
 * extension's global state): where each folder's window was, which windows were open (to
 * restore them), and the zoom level all windows share. The recently opened folders are
 * the normal and the administrator instance's both (a file of their own, recentFolders.ts).
 * No Electron here, so it can be unit tested.
 */

import { normalizeForCompare } from '../node/paths';

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowPlacement {
  readonly bounds?: Bounds;
  readonly maximized?: boolean;
}

interface SavedPlacement extends WindowPlacement {
  readonly folder: string;
  /** Milliseconds since the epoch; the oldest entries go first when there are too many. */
  readonly lastUsed: number;
}

export interface KeyValueStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** The recently opened folders, most recent first; read again each time (another process may write them). */
export interface RecentFoldersFile {
  read(): string[];
  write(folders: readonly string[]): void;
}

const PLACEMENTS_KEY = 'windowPlacements';
const RECENT_KEY = 'recentFolders';
/** The other instance's old recent folders were added to the shared list (`shareOtherRecent`). */
const OTHER_RECENT_KEY = 'otherRecentShared';
const OPEN_KEY = 'openWindows';
const RESTORE_ALL_KEY = 'restoreAllWindows';
const ZOOM_KEY = 'zoomLevel';
const FOLDER_PROVIDERS_KEY = 'folderProviders';

const MAX_PLACEMENTS = 50;
const MAX_RECENT = 20;
/** How far a new window sits from the one it would otherwise cover exactly. */
export const CASCADE_OFFSET = 30;

export function sameFolder(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

/** Recent folders kept in `store` with the rest, as before they were shared (tests). */
function recentIn(store: KeyValueStore): RecentFoldersFile {
  return {
    read: () => stringList(store.get(RECENT_KEY)),
    write: (folders) => store.set(RECENT_KEY, [...folders]),
  };
}

export class WindowHistory {
  private readonly recent: RecentFoldersFile;

  constructor(
    private readonly store: KeyValueStore,
    /** Where the recent folders are, when not in `store`. */
    private readonly shared?: RecentFoldersFile,
  ) {
    this.recent = shared ?? recentIn(store);
  }

  placement(folder: string): WindowPlacement | undefined {
    const saved = this.placements()[normalizeForCompare(folder)];
    return saved ? { bounds: saved.bounds, maximized: saved.maximized } : undefined;
  }

  rememberPlacement(folder: string, placement: WindowPlacement, now = Date.now()): void {
    const placements = { ...this.placements() };
    placements[normalizeForCompare(folder)] = { folder, ...placement, lastUsed: now };
    const kept = Object.entries(placements)
      .sort(([, a], [, b]) => b.lastUsed - a.lastUsed)
      .slice(0, MAX_PLACEMENTS);
    this.store.set(PLACEMENTS_KEY, Object.fromEntries(kept));
  }

  /** Most recent first. */
  recentFolders(): string[] {
    return this.recent.read();
  }

  addRecent(folder: string): void {
    const rest = this.recentFolders().filter((candidate) => !sameFolder(candidate, folder));
    this.recent.write([folder, ...rest].slice(0, MAX_RECENT));
  }

  removeRecent(folder: string): void {
    this.recent.write(this.recentFolders().filter((candidate) => !sameFolder(candidate, folder)));
  }

  /**
   * Moves the recent folders an older version kept in this instance's own state into the
   * shared list, after the ones already there (each instance does it once).
   */
  shareRecent(): void {
    const own = stringList(this.store.get(RECENT_KEY));
    if (!this.shared || own.length === 0) {
      return;
    }
    this.appendRecent(own);
    this.store.set(RECENT_KEY, undefined);
  }

  /**
   * Adds the recent folders an older version kept in the other instance's state to the shared
   * list, after the ones already there, once: that instance may not run again for long (it
   * moves them itself when it does). `readOther` reads its state, which is left as it is; when
   * it throws, the next start tries again.
   */
  shareOtherRecent(readOther: () => unknown): void {
    if (!this.shared || this.store.get(OTHER_RECENT_KEY) === true) {
      return;
    }
    let other: unknown;
    try {
      other = readOther();
    } catch {
      return;
    }
    this.appendRecent(stringList(isRecord(other) ? other[RECENT_KEY] : undefined));
    this.store.set(OTHER_RECENT_KEY, true);
  }

  /** The windows to open at the next start, the last one in front. */
  openWindows(): string[] {
    return stringList(this.store.get(OPEN_KEY));
  }

  setOpenWindows(folders: readonly string[]): void {
    this.store.set(OPEN_KEY, [...folders]);
  }

  /** Makes the next start restore every open window whatever its command line says (a relaunch). */
  setRestoreAll(restoreAll: boolean): void {
    this.store.set(RESTORE_ALL_KEY, restoreAll ? true : undefined);
  }

  /** Reads the restore-all mark and clears it: it applies to one start only. */
  takeRestoreAll(): boolean {
    const restoreAll = this.store.get(RESTORE_ALL_KEY) === true;
    this.store.set(RESTORE_ALL_KEY, undefined);
    return restoreAll;
  }

  /** The API provider a folder's window used last. */
  folderProvider(folder: string): string | undefined {
    const providers = this.store.get(FOLDER_PROVIDERS_KEY);
    const id = isRecord(providers) ? providers[normalizeForCompare(folder)] : undefined;
    return typeof id === 'string' ? id : undefined;
  }

  rememberFolderProvider(folder: string, id: string): void {
    const providers = this.store.get(FOLDER_PROVIDERS_KEY);
    const entries = Object.entries(isRecord(providers) ? providers : {}).filter(([key]) => key !== normalizeForCompare(folder));
    // Most recent last; the oldest go first when there are too many.
    this.store.set(FOLDER_PROVIDERS_KEY, Object.fromEntries([...entries, [normalizeForCompare(folder), id]].slice(-MAX_PLACEMENTS)));
  }

  zoomLevel(): number | undefined {
    const zoom = this.store.get(ZOOM_KEY);
    return typeof zoom === 'number' && Number.isFinite(zoom) ? zoom : undefined;
  }

  setZoomLevel(level: number): void {
    this.store.set(ZOOM_KEY, level === 0 ? undefined : level);
  }

  private appendRecent(folders: readonly string[]): void {
    const shared = this.recentFolders();
    const added = folders.filter((folder) => !shared.some((candidate) => sameFolder(candidate, folder)));
    if (added.length > 0) {
      this.recent.write([...shared, ...added].slice(0, MAX_RECENT));
    }
  }

  private placements(): Record<string, SavedPlacement> {
    const raw = this.store.get(PLACEMENTS_KEY);
    if (!isRecord(raw)) {
      return {};
    }
    const placements: Record<string, SavedPlacement> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (isRecord(value) && typeof value.folder === 'string' && typeof value.lastUsed === 'number') {
        placements[key] = {
          folder: value.folder,
          lastUsed: value.lastUsed,
          bounds: isBounds(value.bounds) ? value.bounds : undefined,
          maximized: value.maximized === true,
        };
      }
    }
    return placements;
  }
}

/**
 * The folders to open at startup, in order (the last one ends up in front): every window
 * that was open after a relaunch; else the folder on the command line; else the windows
 * that were open last time; else `fallback`.
 */
export function foldersToOpen(options: {
  readonly folder: string | undefined;
  readonly restoreAll: boolean;
  readonly previous: readonly string[];
  readonly exists: (folder: string) => boolean;
  readonly fallback: string;
}): string[] {
  const previous: string[] = [];
  for (const folder of options.previous) {
    if (options.exists(folder) && !previous.some((kept) => sameFolder(kept, folder))) {
      previous.push(folder);
    }
  }
  if (options.restoreAll && previous.length > 0) {
    return previous;
  }
  if (options.folder) {
    return [options.folder];
  }
  return previous.length > 0 ? previous : [options.fallback];
}

/** Moves `bounds` down and right while another window sits exactly there. */
export function cascade(bounds: Bounds, taken: readonly Bounds[]): Bounds {
  let next = bounds;
  for (let i = 0; i < 10 && taken.some((other) => other.x === next.x && other.y === next.y); i++) {
    next = { ...next, x: next.x + CASCADE_OFFSET, y: next.y + CASCADE_OFFSET };
  }
  return next;
}

/** A placement as an older version stored it (bounds, maximized), if it is one. */
export function parsePlacement(value: unknown): WindowPlacement | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return { bounds: isBounds(value.bounds) ? value.bounds : undefined, maximized: value.maximized === true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBounds(value: unknown): value is Bounds {
  return isRecord(value) && ['x', 'y', 'width', 'height'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}
