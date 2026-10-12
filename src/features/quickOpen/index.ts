/**
 * Search: the box in the middle of the title bar (after VS Code's command center) and
 * Ctrl+P open quick access; this module adds its workspace files. Also opens files dropped
 * onto the window (outside the webviews, which handle their own drops). Files open through
 * the extension host, so the extension sees the document open like in VS Code.
 */

import { URI } from 'vscode-uri';
import type { ShellModule } from '../../core/module';
import { native } from '../../core/native';
import {
  ICommands,
  IDialogs,
  IExtensionHost,
  IKeybindings,
  ILayout,
  IQuickAccess,
  IWorkspace,
} from '../../core/serviceIds';
import { folderLabel } from '../workspace';
import { matchRanges, scorePath } from './fuzzy';
import { t } from './messages';

/** Files listed for the search; a huge workspace is cut off here. */
const MAX_FILES = 20_000;
/** File rows shown at once. */
const MAX_ROWS = 50;

export const quickOpenModule: ShellModule = {
  id: 'quickOpen',
  activate({ services, subscriptions, logger }) {
    const commands = services.get(ICommands);
    const keybindings = services.get(IKeybindings);
    const dialogs = services.get(IDialogs);
    const connection = services.get(IExtensionHost);
    const workspace = services.get(IWorkspace);
    const quickAccess = services.get(IQuickAccess);

    const open = async (path: string, preview: boolean): Promise<void> => {
      const rpc = connection.rpc;
      const opened = rpc ? await rpc.call('documents.show', { uri: URI.file(path).toString(), preserveFocus: false, preview }) : false;
      if (!opened) {
        await dialogs.showMessage({ severity: 'error', message: t('cannotOpen', path), modal: false, items: [] });
      }
    };

    subscriptions.add(commands.register('quickOpen.show', () => quickAccess.show(''), { title: t('search') }));
    subscriptions.add(keybindings.register({ key: 'ctrl+p', command: 'quickOpen.show' }));
    subscriptions.add(keybindings.register({ key: 'ctrl+e', command: 'quickOpen.show' }));

    // The box names the workspace (it stands for the folder button too) and, in the
    // administrator instance, says so after the name, as VS Code's title does. Opening the
    // search puts the picker right over it (styles.css), so the box seems to become the input.
    const box = document.createElement('div');
    box.className = 'search-box';
    const openButton = document.createElement('button');
    openButton.className = 'search-box-open';
    const label = document.createElement('span');
    label.className = 'search-box-label';
    const folder = workspace.folders[0];
    label.textContent = folder ? t('workspaceLabel', folderLabel(folder, workspace.homeFolder)) : t('search');
    openButton.append(label);
    if (workspace.elevated) {
      const administrator = document.createElement('span');
      administrator.className = 'search-box-administrator';
      administrator.textContent = t('administrator');
      openButton.append(administrator);
    }
    openButton.addEventListener('click', () => void commands.execute('quickOpen.show'));
    // Keybindings are known once every module has registered its own.
    box.addEventListener('mouseenter', () => {
      openButton.title = [
        keybindings.tooltip(t('searchTooltip'), 'quickOpen.show'),
        ...workspace.folders,
        ...(workspace.elevated ? [t('administratorTooltip')] : []),
      ].join('\n');
    });
    box.append(openButton);
    services.get(ILayout).titleBarCenter.appendChild(box);
    subscriptions.add({ dispose: () => box.remove() });

    // The workspace's files, listed once per opening of the picker. Text that looks like a
    // file name or path puts them first, so Ctrl+P, a name and Enter opens the file as in VS Code.
    let files: Promise<string[]> | undefined;
    subscriptions.add(
      quickAccess.registerSearchContributor({
        id: 'files',
        order: (query) => (/[./\\]/.test(query) ? 5 : 30),
        onDidOpen: () => {
          files = undefined;
        },
        provide: async (query) => {
          const root = workspace.folders[0];
          const rpc = connection.rpc;
          if (!query || !root || !rpc) {
            return undefined;
          }
          files ??= rpc.call('documents.listFiles', { maxResults: MAX_FILES });
          const scored = (await files)
            .flatMap((file) => {
              const score = scorePath(file, query);
              return score === undefined ? [] : [{ file, score }];
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_ROWS);
          return {
            label: t('files'),
            items: scored.map(({ file }) => {
              const slash = file.lastIndexOf('/');
              const name = file.slice(slash + 1);
              return {
                label: name,
                labelHighlights: matchRanges(name, query),
                description: slash > 0 ? file.slice(0, slash) : undefined,
                icon: 'file',
                accept: () => open(`${root}/${file}`, true),
              };
            }),
          };
        },
      }),
    );

    // Files dropped onto the shell (the content pane, empty states...) open as tabs.
    const onDragOver = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    };
    const onDrop = (event: DragEvent): void => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      for (const file of files) {
        const path = native.pathForFile(file);
        if (path) {
          void open(path, false).catch((error: unknown) => logger.error(`opening dropped ${path} failed`, error));
        }
      }
    };
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    subscriptions.add({
      dispose: () => {
        document.removeEventListener('dragover', onDragOver);
        document.removeEventListener('drop', onDrop);
      },
    });
  },
};
