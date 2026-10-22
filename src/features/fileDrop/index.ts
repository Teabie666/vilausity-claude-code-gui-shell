/**
 * Files dropped onto the window go where they are dropped: onto the session list or the search
 * box, they are mentioned in the conversation (`@path` in its input; files from outside the
 * workspace are copied into it first, host/main/attachments.ts); onto the conversation, they
 * are attached to the message (the extension's page takes them); onto the content pane, they
 * open in the editor. While they are dragged, the window shows which place does what
 * (overlay.ts).
 */

import { URI } from 'vscode-uri';
import { SettingsSection } from '../../core/messages';
import type { ShellModule } from '../../core/module';
import { IDialogs, IExtensionHost, ILayout, INative, ISettings, IWebviewFrames, IWorkspace } from '../../core/serviceIds';
import { pathInFolder } from '../../platform/fileLinks';
import { IConversations } from '../conversations';
import { t } from './messages';
import { FileDropOverlay, type ZoneSpec } from './overlay';
import { mentionText, type DropAction } from './zones';

/** Where files from outside the workspace are copied (in the workspace) to be mentioned. */
const ATTACHMENTS_FOLDER = 'vilaus.conversations.attachmentsFolder';
const ATTACHMENTS_DEFAULT = 'attachments';

export const fileDropModule: ShellModule = {
  id: 'fileDrop',
  dependsOn: ['conversations', 'contentPane'],
  activate({ services, subscriptions, logger }) {
    const layout = services.get(ILayout);
    const conversations = services.get(IConversations);
    const connection = services.get(IExtensionHost);
    const native = services.get(INative);
    const dialogs = services.get(IDialogs);
    const settings = services.get(ISettings);
    const folder = services.get(IWorkspace).folders[0];

    subscriptions.add(
      settings.register([
        {
          key: ATTACHMENTS_FOLDER,
          section: SettingsSection.workbench,
          order: 12,
          schema: { type: 'string', default: ATTACHMENTS_DEFAULT, description: t('attachmentsFolderSetting') },
        },
      ]),
    );
    const attachmentsFolder = (): string => settings.get(ATTACHMENTS_FOLDER, ATTACHMENTS_DEFAULT).trim() || ATTACHMENTS_DEFAULT;

    const zones = (): ZoneSpec[] => {
      const mention = { action: 'mention', title: t('mention'), detail: t('mentionDetail', attachmentsFolder()) } as const;
      const specs: ZoneSpec[] = [];
      if (folder && layout.sidebarVisible) {
        specs.push({ ...mention, element: layout.sidebar });
      }
      if (folder) {
        specs.push({ ...mention, element: layout.titleBarCenter });
      }
      if (conversations.active) {
        specs.push({ action: 'attach', element: layout.main, title: t('attach') });
      }
      if (layout.contentPaneVisible) {
        specs.push({ action: 'open', element: layout.contentPane, title: t('open') });
      }
      return specs;
    };

    const mention = async (paths: readonly string[]): Promise<void> => {
      if (!folder) {
        return;
      }
      const { placed, failed } = await native.call('files.placeInWorkspace', { paths, folder, subfolder: attachmentsFolder() });
      if (failed.length > 0) {
        void dialogs.showMessage({ severity: 'error', message: t('copyFailed', failed.join('\n')), modal: false, items: [] });
      }
      const mentions = placed.map((path) => mentionText(pathInFolder(path, folder) ?? path));
      const conversation = conversations.active;
      if (mentions.length === 0) {
        return;
      }
      if (conversation) {
        for (const text of mentions) {
          connection.rpc?.notify('conversation.insertMention', { webviewId: conversation.webviewId, text });
        }
      } else {
        // No conversation to mention them in: a new one, with them in its input.
        connection.rpc?.notify('conversation.open', { prompt: `${mentions.join(' ')} ` });
      }
    };

    const open = async (paths: readonly string[]): Promise<void> => {
      for (const path of paths) {
        const shown = await connection.rpc?.call('documents.show', {
          uri: URI.file(path).toString(),
          preserveFocus: false,
          preview: false,
        });
        if (!shown) {
          void dialogs.showMessage({ severity: 'error', message: t('openFailed', path), modal: false, items: [] });
        }
      }
    };

    const drop = (action: DropAction, files: readonly File[]): void => {
      const paths = files.map((file) => native.pathForFile(file)).filter((path) => path !== '');
      const done = action === 'mention' ? mention(paths) : open(paths);
      done.catch((error: unknown) => logger.error(`dropping ${paths.join(', ')} (${action}) failed`, error));
    };

    subscriptions.add(new FileDropOverlay(layout, services.get(IWebviewFrames), zones, drop));
  },
};
