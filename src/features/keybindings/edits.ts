/**
 * What changing a keybinding writes to keybindings.json, the way VS Code's keybindings
 * editor does it: a default is never edited in place; the new chord is added and the default
 * removed (`-command`), so "reset" can take both entries out and the default comes back.
 */

import type { KeybindingRule, ResolvedKeybinding } from '../../core/keybindings';
import type { KeybindingEntry } from '../../platform/keybindings';

export interface KeybindingEdit {
  readonly remove: readonly KeybindingEntry[];
  readonly add: readonly KeybindingEntry[];
}

/** A rule as an entry of keybindings.json: VS Code's `args` is the one argument. */
function entryOf(rule: KeybindingRule, key: string): KeybindingEntry {
  return {
    key,
    command: rule.command,
    ...(rule.when !== undefined ? { when: rule.when } : {}),
    ...(rule.args?.length === 1 ? { args: rule.args[0] } : {}),
  };
}

function removalOf(rule: KeybindingRule): KeybindingEntry {
  return { key: rule.key, command: `-${rule.command}`, ...(rule.when !== undefined ? { when: rule.when } : {}) };
}

/** Gives `rule` the chord `key`; without a rule, binds `command` to it. */
export function changeKeybinding(rule: ResolvedKeybinding | undefined, command: string, key: string): KeybindingEdit {
  if (!rule) {
    return { remove: [], add: [{ key, command }] };
  }
  if (rule.source === 'user' && rule.entry) {
    return { remove: [rule.entry], add: [{ ...rule.entry, key }] };
  }
  return { remove: [], add: [entryOf(rule, key), removalOf(rule)] };
}

export function removeKeybinding(rule: ResolvedKeybinding): KeybindingEdit {
  if (rule.source === 'user' && rule.entry) {
    return { remove: [rule.entry], add: [] };
  }
  return { remove: [], add: [removalOf(rule)] };
}

/** Back to the defaults: whatever keybindings.json adds to or removes from `command`. */
export function resetKeybindings(command: string, entries: readonly KeybindingEntry[]): KeybindingEdit {
  return { remove: entries.filter((entry) => entry.command === command || entry.command === `-${command}`), add: [] };
}
