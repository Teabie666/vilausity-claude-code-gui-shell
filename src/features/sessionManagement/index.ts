/**
 * Session management, a section of the settings (M6.6): how long Claude Code keeps
 * conversations (main writes Claude Code's own `cleanupPeriodDays`, host/main/claudeRetention.ts),
 * the extension's auto-archiving (its setting, listed here by features/settings), and how far
 * back the session list goes (the bridge names the older sessions to the list's page, which
 * hides their rows: host/webview/oldSessions.ts), and whether a conversation shows all its rows
 * (the extension's page shows the last 600). A block above them tells how much room the
 * conversations take, opens their folder, deletes the archived ones of this folder, and says
 * when Claude Code's settings hold a period of their own.
 */

import { URI } from 'vscode-uri';
import { SettingsSection } from '../../core/messages';
import type { ShellModule } from '../../core/module';
import { IDialogs, IExtensionHost, INative, ISettings } from '../../core/serviceIds';
import {
  DELETE_SESSIONS_CHOICES,
  DELETE_SESSIONS_SETTING,
  SHOW_ALL_ROWS_SETTING,
  SHOW_SESSIONS_CHOICES,
  SHOW_SESSIONS_SETTING,
} from '../../platform/defaults';
import type { RetentionDto, SessionStorageDto } from '../../platform/protocol';
import { t } from './messages';

/** "482 MB": bytes in the largest unit that keeps the number above 1. */
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

export const sessionManagementModule: ShellModule = {
  id: 'sessionManagement',
  activate({ services, subscriptions, logger }) {
    const settings = services.get(ISettings);
    const native = services.get(INative);
    const connection = services.get(IExtensionHost);
    const dialogs = services.get(IDialogs);
    const dayLabels = (choices: readonly number[], zero: string): string[] => choices.map((days) => (days === 0 ? zero : t('days', days)));

    subscriptions.add(
      settings.register([
        {
          key: DELETE_SESSIONS_SETTING,
          section: SettingsSection.sessions,
          order: 1,
          showDescription: true,
          schema: {
            type: 'number',
            default: 0,
            enum: [...DELETE_SESSIONS_CHOICES],
            enumItemLabels: dayLabels(DELETE_SESSIONS_CHOICES, t('never')),
            description: t('deleteAfterSetting'),
          },
        },
        {
          key: SHOW_SESSIONS_SETTING,
          section: SettingsSection.sessions,
          order: 3,
          showDescription: true,
          schema: {
            type: 'number',
            default: 0,
            enum: [...SHOW_SESSIONS_CHOICES],
            enumItemLabels: dayLabels(SHOW_SESSIONS_CHOICES, t('all')),
            description: t('showWithinSetting'),
          },
        },
        // Main changes the conversation page's script as it hands it over (host/exthost/bridge.ts, SHOW_ALL_ROWS).
        {
          key: SHOW_ALL_ROWS_SETTING,
          section: SettingsSection.sessions,
          order: 4,
          showDescription: true,
          schema: { type: 'boolean', default: false, description: t('showAllRowsSetting') },
        },
      ]),
    );

    // The session lists hear it from the extension host, each time it connects.
    const tellShownWithin = (): void => {
      const days = settings.get(SHOW_SESSIONS_SETTING, 0);
      connection.rpc
        ?.call('sessions.showWithin', { days: typeof days === 'number' && days > 0 ? days : 0 })
        .catch((error: unknown) => logger.warn('telling the session lists how far back to go failed', error));
    };
    subscriptions.add(connection.onDidConnect(tellShownWithin));
    subscriptions.add(settings.onDidChange((keys) => keys.includes(SHOW_SESSIONS_SETTING) && tellShownWithin()));
    tellShownWithin();

    const deleteArchived = async (): Promise<void> => {
      const rpc = connection.rpc;
      const archived = (await rpc?.call('sessions.archived', undefined)) ?? [];
      if (archived.length === 0) {
        await dialogs.showMessage({ severity: 'info', modal: true, message: t('noArchived'), items: [] });
        return;
      }
      const answer = await dialogs.showMessage({
        severity: 'warning',
        modal: true,
        message: t('confirmDeleteArchived', archived.length),
        items: [t('delete')],
      });
      if (answer !== 0 || !rpc) {
        return;
      }
      let deleted = 0;
      let kept = 0;
      for (const sessionId of archived) {
        const busy = await rpc.call('sessions.busy', { sessionId });
        if (busy === 'elsewhere') {
          kept++;
          continue;
        }
        if (busy === 'open') {
          await rpc.call('sessions.close', { sessionId });
        }
        try {
          const result = await native.call('sessions.delete', { sessionId });
          if (result === 'running') {
            kept++;
          } else {
            deleted++;
          }
        } catch (error) {
          logger.error(`deleting archived session ${sessionId} failed`, error);
          kept++;
        }
      }
      // Not waited for: the block counts the transcripts again meanwhile.
      void dialogs.showMessage({
        severity: 'info',
        modal: false,
        message: kept > 0 ? t('deletedArchived', deleted, kept) : t('deletedAllArchived', deleted),
        items: [],
      });
    };

    subscriptions.add(
      settings.registerWidget({
        id: 'sessionManagement.info',
        section: SettingsSection.sessions,
        keywords: t('keywords'),
        create: (container) => {
          const doc = container.ownerDocument;
          container.classList.add('session-management');
          const line = (className: string, part: string): HTMLElement => {
            const element = doc.createElement('div');
            element.className = className;
            element.dataset.part = part;
            return element;
          };
          const button = (text: string, onClick: () => void): HTMLButtonElement => {
            const created = doc.createElement('button');
            created.className = 'button secondary';
            created.textContent = text;
            created.addEventListener('click', onClick);
            return created;
          };
          const linkButton = (text: string, onClick: () => void): HTMLButtonElement => {
            const created = doc.createElement('button');
            created.className = 'link-button';
            created.textContent = text;
            created.addEventListener('click', onClick);
            return created;
          };

          const storage = line('session-management-line', 'storage');
          storage.textContent = t('storageLoading');
          const own = line('session-management-line session-management-own', 'own');
          own.hidden = true;
          let storageFolder: string | undefined;
          const actions = line('session-management-actions', 'actions');
          actions.append(
            button(t('openFolder'), () => {
              if (storageFolder) {
                void native.call('os.openFolder', { path: storageFolder });
              }
            }),
            button(t('deleteArchived'), () => {
              void deleteArchived()
                .then(() => refresh())
                .catch((error: unknown) => logger.error('deleting the archived sessions failed', error));
            }),
          );
          container.append(own, storage, actions);

          let disposed = false;
          const showStorage = (found: SessionStorageDto): void => {
            storageFolder = found.folder;
            storage.textContent = t('storage', found.sessions, formatBytes(found.bytes));
          };
          const showRetention = (retention: RetentionDto): void => {
            own.hidden = !retention.ownValue || retention.days === null;
            if (!own.hidden) {
              own.replaceChildren(
                t('ownValue', retention.days ?? ''),
                ' ',
                linkButton(t('openClaudeSettings'), () => {
                  void connection.rpc?.call('documents.show', {
                    uri: URI.file(retention.file).toString(),
                    preserveFocus: false,
                    preview: false,
                  });
                }),
              );
            }
          };
          const refresh = (): void => {
            native.call('sessions.storage', undefined).then(
              (found) => !disposed && showStorage(found),
              (error: unknown) => logger.warn('measuring the sessions failed', error),
            );
            native.call('sessions.retention', undefined).then(
              (retention) => !disposed && showRetention(retention),
              (error: unknown) => logger.warn("reading Claude Code's cleanupPeriodDays failed", error),
            );
          };
          refresh();
          // The period the setting just wrote, or found Claude Code's own.
          const subscription = settings.onDidChange((keys) => keys.includes(DELETE_SESSIONS_SETTING) && refresh());
          return {
            dispose: () => {
              disposed = true;
              subscription.dispose();
            },
          };
        },
      }),
    );
  },
};
