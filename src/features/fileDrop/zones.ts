/** Where in the window dropped files go, and how a dropped file is mentioned (pure: the module and its tests use it). */

/**
 * What dropping files does: mention them in the conversation (copied into the workspace when
 * outside it), attach them to the message (the conversation page takes them itself), or open
 * them in the editor.
 */
export type DropAction = 'mention' | 'attach' | 'open';

export interface ZoneRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface DropZone {
  readonly action: DropAction;
  readonly rect: ZoneRect;
}

/** The zone at a point of the window, if any. */
export function zoneAt<T extends DropZone>(zones: readonly T[], x: number, y: number): T | undefined {
  return zones.find(({ rect }) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom);
}

/**
 * How the conversation's input mentions a file at `path` (relative to the workspace): `@` and
 * the path with `/` between its parts, in double quotes when it has white space, as the
 * extension writes mentions.
 */
export function mentionText(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  return /\s/.test(slashed) ? `@"${slashed}"` : `@${slashed}`;
}
