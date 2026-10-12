/**
 * Built-in VS Code commands the extension calls, as vilaus understands them. vilaus has
 * one editor group and no explorer, so most layout commands are deliberate no-ops;
 * registering them keeps shim-unimplemented.log about real gaps only. The rest are done by
 * the shell (the renderer) or main.
 */

import type * as vscode from 'vscode';
import type { CommandRegistry } from '../../compat/vscode/commands';
import type { MainRpc, RendererRpc } from './compatHost';

/** Layout commands that have no meaning with a single editor group. */
const LAYOUT_NO_OPS = [
  'workbench.action.lockEditorGroup',
  'workbench.action.unlockEditorGroup',
  'workbench.action.newGroupRight',
  'workbench.action.newGroupBelow',
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusActiveEditorGroup',
  'workbench.action.closeEditorsInGroup',
  'workbench.action.pinEditor',
  'workbench.action.keepEditor',
  // There is no file explorer in vilaus.
  'revealInExplorer',
  'workbench.files.action.focusFilesExplorer',
];

/** A file URI's path; undefined for anything else. */
function filePath(value: unknown): string | undefined {
  const uri = value as Partial<vscode.Uri> | undefined;
  return typeof uri === 'object' && uri !== null && uri.scheme === 'file' && typeof uri.fsPath === 'string' ? uri.fsPath : undefined;
}

export function registerWorkbenchCommands(commands: CommandRegistry, hosts: { main: MainRpc; renderer: RendererRpc }): void {
  for (const id of LAYOUT_NO_OPS) {
    commands.registerBuiltin(id, () => undefined);
  }

  // `vscode.openFolder(uri?, newWindow? | { forceNewWindow? })`: VS Code asks for a folder
  // when there is no uri, and opens it in the same window unless told otherwise. The
  // extension's "open folder" buttons call it (checked against 2.1.282).
  commands.registerBuiltin('vscode.openFolder', async (uri, options) => {
    const newWindow =
      options === true ||
      (typeof options === 'object' && options !== null && (options as { forceNewWindow?: unknown }).forceNewWindow === true);
    await hosts.renderer.call('workspace.openFolder', { folder: filePath(uri), newWindow });
  });

  // `workbench.action.openSettings(query? | { query? })`: the extension's "open
  // configuration" passes a search for its own settings.
  commands.registerBuiltin('workbench.action.openSettings', async (argument) => {
    const query =
      typeof argument === 'string'
        ? argument
        : typeof argument === 'object' && argument !== null && typeof (argument as { query?: unknown }).query === 'string'
          ? (argument as { query: string }).query
          : undefined;
    await hosts.renderer.call('workbench.openSettings', { query });
  });

  commands.registerBuiltin('revealFileInOS', (uri) => {
    const path = filePath(uri);
    if (path) {
      hosts.main.notify('os.revealFile', { path });
    }
  });
}
