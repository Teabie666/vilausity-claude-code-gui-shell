/**
 * Numbers as people read them: sizes in the largest unit that keeps the number readable,
 * and integers with thousands separators. Shared by the settings' session management and
 * the statistics tab (features/stats).
 */

const INTEGER_FORMAT = new Intl.NumberFormat('en-US');

/** `1234567` -> `"1,234,567"`. */
export function formatInteger(value: number): string {
  return INTEGER_FORMAT.format(value);
}

/** `482` -> `"482 B"`, `493568` -> `"482 KB"`: the largest unit that keeps the number above 1. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
