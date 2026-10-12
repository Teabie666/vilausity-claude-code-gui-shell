/** Theme colors as Monaco takes them: `#rrggbb[aa]` under VS Code color ids. */

/** `#abc`, `#aabbcc`, `#aabbccdd` and `rgb[a](r, g, b[, a])` as `#rrggbb[aa]`; else undefined. */
export function toHexColor(value: string): string | undefined {
  const text = value.trim();
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) {
    if (text.length <= 5) {
      return `#${text.slice(1).replace(/./g, '$&$&')}`.toLowerCase();
    }
    return text.toLowerCase();
  }
  const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(text);
  if (!match) {
    return undefined;
  }
  const hex = (n: number): string =>
    Math.round(Math.max(0, Math.min(255, n)))
      .toString(16)
      .padStart(2, '0');
  const [r, g, b] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  const alpha = match[4] === undefined ? '' : hex(Number(match[4]) * 255);
  return `#${hex(r)}${hex(g)}${hex(b)}${alpha === 'ff' ? '' : alpha}`;
}

/** `vscode-editorLineNumber-activeForeground` -> `editorLineNumber.activeForeground`. */
export function colorIdForVariable(variable: string): string | undefined {
  const name = variable.startsWith('vscode-') ? variable.slice('vscode-'.length) : undefined;
  const dash = name?.indexOf('-') ?? -1;
  return name && dash > 0 ? `${name.slice(0, dash)}.${name.slice(dash + 1)}` : undefined;
}
