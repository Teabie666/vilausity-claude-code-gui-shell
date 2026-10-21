/**
 * The paths of files a conversation links to, as the shell resolves them (features/fileLinks):
 * the page has them as Claude wrote them, absolute or relative to the workspace, maybe with a
 * line number after them. Windows paths; no Node here (the renderer uses it).
 */

/** A path's parts with `.` and `..` worked out, `\` between them; `C:` keeps its root. */
function normalize(path: string): string {
  const unc = path.startsWith('\\\\') || path.startsWith('//');
  const parts: string[] = [];
  for (const part of path.split(/[\\/]+/)) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (parts.length > 1 || (parts.length === 1 && !/^[a-z]:$/i.test(parts[0]!))) {
        parts.pop();
      }
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join('\\');
  return unc ? `\\\\${joined}` : /^[a-z]:$/i.test(joined) ? `${joined}\\` : joined;
}

/** `linked` as an absolute path: a `file:` URL's, a drive's or a share's as it is, else in `folder`. */
function absolute(linked: string, folder: string | undefined): string | undefined {
  let path = linked.trim();
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname).replace(/^\/([a-z]:)/i, '$1');
    } catch {
      return undefined;
    }
  }
  // Git Bash's way of writing a drive: /c/Users/...
  const bash = /^\/([a-z])(\/.*)?$/i.exec(path);
  if (bash) {
    path = `${bash[1]!.toUpperCase()}:${bash[2] ?? '\\'}`;
  }
  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\') || path.startsWith('//')) {
    return normalize(path);
  }
  return folder ? normalize(`${folder}\\${path}`) : undefined;
}

/**
 * Where the file `linked` may be, best guess first: the path as given (in `folder` when
 * relative), then without a line after it (`:12`, `:12:5`, `:12-20`, `#L12`).
 */
export function linkPathCandidates(linked: string, folder: string | undefined): string[] {
  const candidates: string[] = [];
  const bare = linked.replace(/(?::\d+(?:[-:]\d+)?|#L\d+(?:-L?\d+)?)$/, '');
  for (const candidate of [linked, bare]) {
    const path = absolute(candidate, folder);
    if (path && !candidates.includes(path)) {
      candidates.push(path);
    }
  }
  return candidates;
}

/** `path` relative to `folder` when it is inside it (`\` between the parts), else undefined. */
export function pathInFolder(path: string, folder: string | undefined): string | undefined {
  if (!folder) {
    return undefined;
  }
  const root = normalize(folder).replace(/\\$/, '');
  const target = normalize(path);
  return target.toLowerCase().startsWith(`${root.toLowerCase()}\\`) ? target.slice(root.length + 1) : undefined;
}
