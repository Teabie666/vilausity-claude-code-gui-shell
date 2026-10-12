/** Tab labels for documents and diffs. */

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** For comparing paths: lower case, `\` separators, no `/` before a drive letter. */
function comparablePath(path: string): string {
  return path
    .replace(/^\/(?=[A-Za-z]:)/, '')
    .replace(/\//g, '\\')
    .toLowerCase();
}

/**
 * A diff title for the tab, with folders dropped from the paths in it. Titles may carry
 * whole Windows paths (e.g. an extension that takes the name after the last `/`); the
 * documents' own paths are replaced first, as they may contain spaces, then any other
 * absolute path without spaces.
 */
export function shortDiffTitle(title: string, paths: readonly string[]): string {
  let result = title;
  for (const path of paths) {
    const name = basename(path);
    const needle = comparablePath(path);
    const drive = /^[a-z]:/.test(needle);
    let index = name !== path && needle ? comparablePath(result).indexOf(needle) : -1;
    while (index >= 0) {
      // A URI-style `/c:/...` has a separator before the drive letter; it goes too.
      const start = drive && index > 0 && /[\\/]/.test(result[index - 1]!) ? index - 1 : index;
      result = result.slice(0, start) + name + result.slice(index + needle.length);
      index = comparablePath(result).indexOf(needle, start + name.length);
    }
  }
  return result.replace(/(?:[A-Za-z]:)?[\\/](?:[^\\/\s→↔]+[\\/])+/g, '');
}
