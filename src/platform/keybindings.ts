/**
 * Key chords, shared by main (which intercepts them before the page sees them) and the
 * renderer (which maps them to commands). A chord is a normalized string such as
 * `ctrl+shift+p`: modifiers in the fixed order ctrl, shift, alt, meta, then the key.
 *
 * Keys come from `KeyboardEvent.code` (physical key), so shortcuts do not change with the
 * keyboard layout or with Shift turning `=` into `+`.
 */

const CODE_TO_KEY: Readonly<Record<string, string>> = {
  Equal: '=',
  Minus: '-',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Tab: 'tab',
  Escape: 'escape',
  Enter: 'enter',
  Space: 'space',
  Backspace: 'backspace',
  Delete: 'delete',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Home: 'home',
  End: 'end',
  NumpadAdd: 'numpad_add',
  NumpadSubtract: 'numpad_subtract',
};

const MODIFIER_ORDER = ['ctrl', 'shift', 'alt', 'meta'] as const;

export interface ChordInput {
  readonly code: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

/** `KeyN` -> `n`, `Digit1` -> `1`, `F5` -> `f5`; undefined for pure modifier keys. */
export function keyFromCode(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3).toLowerCase();
  }
  if (/^(Digit|Numpad)[0-9]$/.test(code)) {
    return code.slice(-1);
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    return code.toLowerCase();
  }
  return CODE_TO_KEY[code];
}

export function chordFromInput(input: ChordInput): string | undefined {
  const key = keyFromCode(input.code);
  if (!key) {
    return undefined;
  }
  const parts: string[] = [];
  if (input.ctrl) parts.push('ctrl');
  if (input.shift) parts.push('shift');
  if (input.alt) parts.push('alt');
  if (input.meta) parts.push('meta');
  parts.push(key);
  return parts.join('+');
}

/** VS Code's names for the Windows key (and the Mac's Command key, in shared files). */
const META_ALIASES = new Set(['win', 'cmd', 'super']);

/** Normalizes a human-written chord (`Ctrl+Shift+P`, `shift+ctrl+p`) to canonical form. */
export function normalizeChord(chord: string): string {
  const parts = chord
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (META_ALIASES.has(part) ? 'meta' : part));
  const key = parts.filter((part) => !(MODIFIER_ORDER as readonly string[]).includes(part)).pop() ?? '';
  const modifiers = MODIFIER_ORDER.filter((modifier) => parts.includes(modifier));
  return [...modifiers, key].join('+');
}

/**
 * Whether a chord leaves typing alone: it has Ctrl, Alt or the Windows key, or is a function
 * key. Main takes every bound chord before any page sees it, so binding a plain or shifted
 * key would take that character away from every text field.
 */
export function isCommandChord(chord: string): boolean {
  const parts = normalizeChord(chord).split('+');
  const key = parts.at(-1) ?? '';
  return /^f([1-9]|1[0-9]|2[0-4])$/.test(key) || parts.some((part) => part === 'ctrl' || part === 'alt' || part === 'meta');
}

/**
 * An entry of keybindings.json, in VS Code's format: `command` with a `-` in front removes
 * the default keybindings of that command that match `key` (all of them when it is empty)
 * and `when` (when given). `args` is the command's one argument.
 */
export interface KeybindingEntry {
  readonly key: string;
  readonly command: string;
  readonly when?: string;
  readonly args?: unknown;
}

/**
 * The entries of keybindings.json (an array) that can take effect. Skipped: entries without
 * a key or command, and chord sequences (`ctrl+k ctrl+s`), which the shell does not have.
 */
export function parseKeybindingEntries(value: unknown): KeybindingEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: KeybindingEntry[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const { key, command, when, args } = item as Record<string, unknown>;
    if (typeof key !== 'string' || typeof command !== 'string' || command.replace(/^-/, '').trim() === '') {
      continue;
    }
    const removal = command.startsWith('-');
    if ((!removal && key.trim() === '') || /\S\s+\S/.test(key.trim().replace(/\s*\+\s*/g, '+'))) {
      continue;
    }
    entries.push({
      key,
      command,
      ...(typeof when === 'string' && when.trim() !== '' ? { when } : {}),
      ...(args !== undefined ? { args } : {}),
    });
  }
  return entries;
}

/** The same entry of keybindings.json (as written there). */
export function sameKeybindingEntry(a: KeybindingEntry, b: KeybindingEntry): boolean {
  return a.key === b.key && a.command === b.command && (a.when ?? '') === (b.when ?? '') && JSON.stringify(a.args) === JSON.stringify(b.args);
}

/** Keys whose label is not just the name capitalized; VS Code's labels. */
const KEY_LABELS: Readonly<Record<string, string>> = {
  meta: 'Win',
  up: 'UpArrow',
  down: 'DownArrow',
  left: 'LeftArrow',
  right: 'RightArrow',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  numpad_add: 'NumPad_Add',
  numpad_subtract: 'NumPad_Subtract',
};

/** `ctrl+shift+p` -> `Ctrl+Shift+P`, for menus and tooltips. */
export function formatChord(chord: string): string {
  return chord
    .split('+')
    .map((part) => KEY_LABELS[part] ?? (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('+');
}
