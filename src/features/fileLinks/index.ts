/**
 * Files a conversation links to (Markdown links in Claude's replies, @-mentions, the file
 * names of tool calls): Shift+click opens the file with its program, as a file manager would;
 * right-click shows a menu for it (open in the editor or with its program, show it in File
 * Explorer, copy its path). The page script holds back the message that asks the extension to
 * open the file (host/webview/fileLinks.ts); "Open in Editor" lets it through, so the editor
 * opens it as a plain click does, at the line linked to.
 */

import type { ShellModule } from '../../core/module';
import { IDialogs, INative, IWebviewFrames, IWorkspace } from '../../core/serviceIds';
import type { FileLinkRequest } from '../../core/webviewFrames';
import { linkPathCandidates, pathInFolder } from '../../platform/fileLinks';
import type { PopupMenuItemDto } from '../../platform/protocol';
import { t } from './messages';

export type FileLinkAction = 'editor' | 'system' | 'reveal' | 'copyPath' | 'copyRelativePath' | 'copyLink';

/** Where a linked file was found, and what it is; undefined when the shell cannot find it. */
export type LinkedPath = { readonly path: string; readonly kind: 'file' | 'folder' } | undefined;

/** The menu for a linked file (a folder has File Explorer for its program); `link`: a Markdown link's href. */
export function fileLinkMenu(found: LinkedPath, link: string | undefined, folder: string | undefined): PopupMenuItemDto[] {
  const items: PopupMenuItemDto[] = [];
  const add = (id: FileLinkAction, label: string): void => {
    items.push({ id, label });
  };
  if (found?.kind === 'folder') {
    add('system', t('openInExplorer'));
  } else {
    // A file the shell cannot find: the extension looks for it its own way.
    add('editor', t('openInEditor'));
    if (found) {
      add('system', t('openWithDefault'));
      add('reveal', t('revealInExplorer'));
    }
  }
  if (found) {
    items.push({});
    add('copyPath', t('copyPath'));
    if (pathInFolder(found.path, folder)) {
      add('copyRelativePath', t('copyRelativePath'));
    }
  }
  if (link) {
    items.push({});
    add('copyLink', t('copyLink'));
  }
  return items;
}

export const fileLinksModule: ShellModule = {
  id: 'fileLinks',
  activate({ services, subscriptions, logger }) {
    const frames = services.get(IWebviewFrames);
    const native = services.get(INative);
    const dialogs = services.get(IDialogs);
    const folder = services.get(IWorkspace).folders[0];

    /** The first candidate that is there, and what it is. */
    const locate = async (linked: string): Promise<LinkedPath> => {
      for (const path of linkPathCandidates(linked, folder)) {
        const kind = await native.call('os.pathKind', { path });
        if (kind) {
          return { path, kind };
        }
      }
      return undefined;
    };

    const openWithProgram = async (path: string): Promise<void> => {
      if (!(await native.call('os.openPath', { path }))) {
        void dialogs.showMessage({ severity: 'error', message: t('openFailed', path), modal: false, items: [] });
      }
    };

    const handle = async ({ webviewId, id, path: linked, intent, link }: FileLinkRequest): Promise<void> => {
      const found = await locate(linked);
      if (intent === 'system') {
        // Not found: the extension opens it in the editor, as a plain click does.
        frames.answerFileLink(webviewId, id, found === undefined);
        if (found) {
          await openWithProgram(found.path);
        }
        return;
      }
      const chosen = (await native.call('window.popupMenu', { items: fileLinkMenu(found, link, folder) })) as FileLinkAction | undefined;
      frames.answerFileLink(webviewId, id, chosen === 'editor');
      if (!chosen || chosen === 'editor') {
        return;
      }
      if (chosen === 'copyLink') {
        await native.call('os.clipboardWrite', { text: link ?? '' });
        return;
      }
      if (!found) {
        return;
      }
      switch (chosen) {
        case 'system':
          await openWithProgram(found.path);
          break;
        case 'reveal':
          await native.call('os.revealPath', { path: found.path });
          break;
        case 'copyPath':
          await native.call('os.clipboardWrite', { text: found.path });
          break;
        case 'copyRelativePath':
          await native.call('os.clipboardWrite', { text: pathInFolder(found.path, folder) ?? found.path });
          break;
      }
    };

    subscriptions.add(
      frames.onDidRequestFileLink((request) => {
        handle(request).catch((error: unknown) => {
          logger.error(`the file link ${request.path} failed`, error);
          frames.answerFileLink(request.webviewId, request.id, false);
        });
      }),
    );
  },
};
