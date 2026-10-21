/**
 * The window's workspace folder: the commands that open folders, and the folders group of
 * the search (the title bar's search box shows the folder's name). Folders open here (in
 * place of the current one, as VS Code does) or in a new window. A folder has at
 * most one window: opening one that another window shows brings that window forward.
 * Opening a folder here closes this window's conversations and files (unsaved changes are
 * asked about first); the conversations come back when the old folder is opened again.
 */

import { CommandCategory, SettingsSection } from '../../core/messages';
import type { ShellModule } from '../../core/module';
import { ICommands, IDialogs, IExtensionHost, IKeybindings, INative, IQuickAccess, ISettings, IWorkspace } from '../../core/serviceIds';
import type { QuickAccessItem } from '../../core/quickAccess';
import type { QuickPickItemDto } from '../../platform/protocol';
import { IContentPane } from '../contentPane';
import { IConversations } from '../conversations';
import { t } from './messages';

/** Windows paths compare case-insensitively, with either slash. */
export function sameFolder(a: string, b: string): boolean {
  const normalize = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

export function folderName(folder: string): string {
  return (
    folder
      .split(/[\\/]/)
      .filter((part) => part.length > 0)
      .pop() ?? folder
  );
}

/**
 * A folder as the shell names it: its base name, and for the user's home folder a note that
 * it stands for the whole computer (Claude works anywhere from there).
 */
export function folderLabel(folder: string, homeFolder: string): string {
  const name = folderName(folder);
  return homeFolder && sameFolder(folder, homeFolder) ? t('globalFolder', name) : name;
}

interface PickEntry {
  readonly item: QuickPickItemDto;
  /** Enter, or a click. */
  readonly run?: () => Promise<void>;
  /** Ctrl+Enter, or a Ctrl+click; defaults to `run`. */
  readonly alternate?: () => Promise<void>;
}

export const workspaceModule: ShellModule = {
  id: 'workspace',
  dependsOn: ['conversations', 'contentPane'],
  async activate({ services, subscriptions }) {
    const commands = services.get(ICommands);
    const keybindings = services.get(IKeybindings);
    const native = services.get(INative);
    const dialogs = services.get(IDialogs);
    const workspace = services.get(IWorkspace);
    const current = workspace.folders[0] ?? '';

    const openIn = async (folder: string, newWindow: boolean): Promise<void> => {
      if (!(await native.call('window.openFolder', { folder, newWindow }))) {
        void dialogs.showMessage({ severity: 'error', message: t('folderMissing', folder), modal: false, items: [] });
      }
    };

    /** Asks about each unsaved file as closing its tab would; false when the user kept one. */
    const closeDirtyEditors = async (): Promise<boolean> => {
      const pane = services.tryGet(IContentPane);
      if (!pane) {
        return true;
      }
      const dirty = new Set([...pane.tabs, ...pane.floating].filter((tab) => tab.isDirty).map((tab) => tab.input.id));
      for (const id of dirty) {
        if (!(await pane.close(id))) {
          return false;
        }
      }
      return true;
    };

    /** Shows `folder` in this window, once the user agrees to close what is open here. */
    const openHere = async (folder: string): Promise<void> => {
      if (sameFolder(folder, current)) {
        return;
      }
      const shownElsewhere = (await native.call('window.shownFolders', undefined)).some((other) => sameFolder(other, folder));
      const conversations = services.tryGet(IConversations)?.count ?? 0;
      const files = services.tryGet(IContentPane)?.tabs.length ?? 0;
      if (!shownElsewhere && conversations + files > 0) {
        const choice = await dialogs.showMessage({
          severity: 'info',
          modal: true,
          message: t('replaceTitle', folderName(folder)),
          detail: t('replaceDetail', workspace.name),
          items: [t('open'), t('openInNewWindow')],
        });
        if (choice === 1) {
          await openIn(folder, true);
          return;
        }
        if (choice !== 0 || !(await closeDirtyEditors())) {
          return;
        }
      }
      await openIn(folder, false);
    };

    const browse = async (newWindow: boolean): Promise<void> => {
      const folder = await native.call('window.pickFolder', undefined);
      if (folder) {
        await (newWindow ? openIn(folder, true) : openHere(folder));
      }
    };

    const recentEntries = async (newWindow: boolean): Promise<PickEntry[]> => {
      const [recent, shown] = await Promise.all([
        native.call('window.recentFolders', undefined),
        native.call('window.shownFolders', undefined),
      ]);
      const entries = recent
        .filter((folder) => !sameFolder(folder, current))
        .map((folder): PickEntry => ({
          item: {
            label: folderLabel(folder, workspace.homeFolder),
            description: shown.some((other) => sameFolder(other, folder)) ? `${folder} - ${t('openElsewhere')}` : folder,
          },
          run: () => (newWindow ? openIn(folder, true) : openHere(folder)),
          alternate: () => openIn(folder, true),
        }));
      return entries.length > 0 ? [{ item: { label: t('recent'), separator: true } }, ...entries] : [];
    };

    const pick = async (placeHolder: string, entries: readonly PickEntry[]): Promise<void> => {
      const runAlternate = (index: number): void => {
        const entry = entries[index];
        void (entry?.alternate ?? entry?.run)?.();
      };
      const chosen = await dialogs.showQuickPick(
        { items: entries.map((entry) => entry.item), placeHolder, canPickMany: false },
        { alternate: runAlternate },
      );
      const index = chosen?.[0];
      if (index !== undefined) {
        await entries[index]?.run?.();
      }
    };

    subscriptions.add(
      commands.register('workspace.openFolder', () => browse(false), {
        title: t('openFolder'),
        category: CommandCategory.file,
      }),
    );
    subscriptions.add(
      commands.register('workspace.openFolderInNewWindow', () => browse(true), {
        title: t('openFolderInNewWindow'),
        category: CommandCategory.file,
      }),
    );
    subscriptions.add(
      commands.register('workspace.revealFolder', () => native.call('os.openFolder', { path: current }), {
        title: t('revealFolder'),
        category: CommandCategory.file,
      }),
    );
    // A terminal of its own in the workspace folder (host/main/terminal.ts says which).
    const openTerminal = async (): Promise<void> => {
      if (!(await native.call('os.openTerminal', { folder: current }))) {
        void dialogs.showMessage({ severity: 'error', message: t('terminalFailed'), modal: false, items: [] });
      }
    };
    subscriptions.add(
      commands.register('workspace.openTerminal', openTerminal, {
        title: t('openTerminal'),
        category: CommandCategory.file,
      }),
    );
    subscriptions.add(
      services.get(ISettings).register([
        {
          key: 'terminal.external.windowsExec',
          section: SettingsSection.workbench,
          order: 30,
          showDescription: true,
          schema: { type: 'string', default: '', description: t('terminalSetting') },
        },
      ]),
    );
    // Not offered in the administrator instance itself.
    const elevated = workspace.elevated;
    const openAsAdministrator = (): Promise<void> => native.call('window.openFolderAsAdministrator', { folder: current });
    subscriptions.add(
      commands.register(
        'workspace.openRecent',
        async () =>
          pick(t('pickToOpen'), [
            { item: { label: t('openFolder') }, run: () => browse(false), alternate: () => browse(true) },
            { item: { label: t('openFolderInNewWindow') }, run: () => browse(true) },
            { item: { label: t('revealFolder') }, run: () => native.call('os.openFolder', { path: current }) },
            ...(elevated ? [] : [{ item: { label: t('openAsAdministrator') }, run: openAsAdministrator }]),
            ...(await recentEntries(false)),
          ]),
        { title: t('openRecent'), category: CommandCategory.file },
      ),
    );
    if (!elevated) {
      subscriptions.add(
        commands.register('workspace.openAsAdministrator', openAsAdministrator, {
          title: t('openAsAdministrator'),
          category: CommandCategory.file,
        }),
      );
    }
    subscriptions.add(
      commands.register(
        'workspace.newWindow',
        async () =>
          pick(t('pickForNewWindow'), [{ item: { label: t('browse') }, run: () => browse(true) }, ...(await recentEntries(true))]),
        { title: t('newWindow'), category: CommandCategory.file },
      ),
    );
    subscriptions.add(keybindings.register({ key: 'ctrl+r', command: 'workspace.openRecent' }));
    subscriptions.add(keybindings.register({ key: 'ctrl+shift+n', command: 'workspace.newWindow' }));

    // In the search: with nothing typed, the latest folders and ways to open others; with
    // text, the recent folders it matches.
    subscriptions.add(
      services.get(IQuickAccess).registerSearchContributor({
        id: 'folders',
        order: 40,
        provide: async (query) => {
          const needle = query.toLowerCase();
          const [recent, shown] = await Promise.all([
            native.call('window.recentFolders', undefined),
            native.call('window.shownFolders', undefined),
          ]);
          const items: QuickAccessItem[] = recent
            .filter((folder) => !sameFolder(folder, current))
            .flatMap((folder): QuickAccessItem[] => {
              const name = folderName(folder);
              const at = name.toLowerCase().indexOf(needle);
              if (needle && at < 0 && !folder.toLowerCase().includes(needle)) {
                return [];
              }
              return [
                {
                  label: folderLabel(folder, workspace.homeFolder),
                  labelHighlights: needle && at >= 0 ? [[at, at + needle.length]] : undefined,
                  description: shown.some((other) => sameFolder(other, folder)) ? `${folder} - ${t('openElsewhere')}` : folder,
                  icon: 'folder',
                  accept: (alternate) => (alternate ? openIn(folder, true) : openHere(folder)),
                },
              ];
            })
            .slice(0, needle ? 5 : 3);
          if (!needle) {
            items.push(
              { label: t('openFolder'), icon: 'folder', accept: (alternate) => browse(alternate) },
              {
                label: t('openRecent'),
                icon: 'folder',
                keybinding: keybindings.labelFor('workspace.openRecent'),
                accept: () => commands.execute('workspace.openRecent'),
              },
            );
            if (!elevated) {
              items.push({ label: t('openAsAdministrator'), icon: 'shield', accept: () => openAsAdministrator() });
            }
            items.push(
              {
                label: t('revealFolder'),
                icon: 'folder-opened',
                keybinding: keybindings.labelFor('workspace.revealFolder'),
                accept: () => native.call('os.openFolder', { path: current }),
              },
              {
                label: t('openTerminal'),
                icon: 'terminal',
                keybinding: keybindings.labelFor('workspace.openTerminal'),
                accept: openTerminal,
              },
            );
          }
          return items.length > 0 ? { label: t('folders'), items } : undefined;
        },
      }),
    );

    // The extension's "open folder" buttons (`vscode.openFolder`).
    subscriptions.add(
      services.get(IExtensionHost).onDidConnect((rpc) => {
        rpc.handle('workspace.openFolder', async ({ folder, newWindow }) => {
          if (!folder) {
            await browse(newWindow);
          } else {
            await (newWindow ? openIn(folder, true) : openHere(folder));
          }
        });
      }),
    );
  },
};
