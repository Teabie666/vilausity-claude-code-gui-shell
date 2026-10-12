/** The default keybindings as text, for the left of keybindings.json (features/editor/defaultsSplitPane.ts). */

import type { KeybindingRule } from '../../core/keybindings';

/**
 * The keybindings modules register, written as keybindings.json writes them (VS Code's
 * Default Keybindings), each under its command's title; `header` goes first, as comments.
 */
export function defaultKeybindingsText(rules: readonly KeybindingRule[], titleOf: (command: string) => string, header: string): string {
  const lines = [...header.split('\n').map((line) => `// ${line}`), '['];
  rules.forEach((rule, index) => {
    const title = titleOf(rule.command);
    if (title) {
      lines.push(`  // ${title}`);
    }
    const fields = [`"key": ${JSON.stringify(rule.key)}`, `"command": ${JSON.stringify(rule.command)}`];
    if (rule.when) {
      fields.push(`"when": ${JSON.stringify(rule.when)}`);
    }
    if (rule.args?.length === 1) {
      fields.push(`"args": ${JSON.stringify(rule.args[0])}`);
    }
    lines.push(`  { ${fields.join(', ')} }${index < rules.length - 1 ? ',' : ''}`);
  });
  lines.push(']');
  return `${lines.join('\n')}\n`;
}
