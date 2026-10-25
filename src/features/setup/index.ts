/**
 * The setup guide (M6.7): a new version's first run, in a tab beside the conversations (a
 * conversation already open keeps its own), in three pages —
 * the Claude Code extension (installed or downloaded), the connection to Claude (an API
 * provider, or a Claude account), and the workspace (the folder this window shows).
 * Main asks for it at startup (onboarding.take); it also opens whenever the extension is
 * not running, and from the command palette. A finished or skipped guide starts the quick
 * start, and opens a conversation when the window has none, so a Claude account can sign
 * in. The extension starts in every window as soon as it is installed; no restart.
 * Also the notices shown once: Git for Windows missing.
 */

import { CommandCategory } from '../../core/messages';
import type { ShellModule } from '../../core/module';
import { ICommands, IDialogs, INative } from '../../core/serviceIds';
import { IConversations } from '../conversations';
import type { ShellTab } from '../conversations/conversationTabs';
import { connectionPage } from './connectionPage';
import { extensionPage } from './extensionPage';
import { SetupGuide } from './guide';
import { t } from './messages';
import { workspacePage } from './workspacePage';

const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads/win';

export const setupModule: ShellModule = {
  id: 'setup',
  dependsOn: ['conversations', 'providers', 'extensionUpdates', 'settings', 'quickStart'],
  async activate({ services, subscriptions, logger }) {
    const native = services.get(INative);
    const dialogs = services.get(IDialogs);
    const commands = services.get(ICommands);

    // Shown once the guide is closed: a notification would sit over its buttons.
    let noticesShown = false;
    const showNotices = (): void => {
      if (noticesShown) {
        return;
      }
      noticesShown = true;
      void native.call('app.startupNotices', undefined).then(
        async ({ gitMissing }) => {
          if (!gitMissing) {
            return;
          }
          const choice = await dialogs.showMessage({
            severity: 'info',
            // (A notification shows no detail, as in VS Code: the message says it all.)
            message: t('gitMissing'),
            modal: false,
            items: [t('downloadGit'), t('dontShowAgain')],
          });
          if (choice === 0) {
            await native.call('os.openExternal', { url: GIT_DOWNLOAD_URL });
          }
        },
        (error: unknown) => logger.error('reading the startup notices failed', error),
      );
    };

    /** The quick start after the guide; it finishes the onboarding itself when it is there. */
    const startQuickStart = async (): Promise<void> => {
      try {
        if (commands.has('quickStart.open')) {
          await commands.execute('quickStart.open', { onboarding: true });
        } else {
          await native.call('onboarding.done', undefined);
        }
      } catch (error) {
        logger.error('starting the quick start failed', error);
      }
    };

    /** What follows the guide's close: the quick start, and a conversation to sign in in. */
    const closed = async (automatic: boolean): Promise<void> => {
      if (automatic) {
        await startQuickStart();
      }
      try {
        // With nothing open, the extension shows its sign-in in a conversation, if it needs one.
        const status = await native.call('extension.status', undefined);
        if (status.running && (services.tryGet(IConversations)?.count ?? 0) === 0) {
          await commands.execute('conversations.new');
        }
      } catch (error) {
        logger.error('opening a conversation after the setup guide failed', error);
      }
    };

    const conversations = services.get(IConversations);
    let guide: { readonly view: SetupGuide; readonly tab: ShellTab } | undefined;
    const open = (automatic: boolean): void => {
      if (guide) {
        guide.tab.reveal();
        return;
      }
      const tab = conversations.openShellTab({
        title: t('guideLabel'),
        onClose: () => guide?.view.exit(),
        onFocus: () => guide?.view.focus(),
      });
      const view = new SetupGuide(tab.container, {
        services,
        logger,
        automatic,
        pages: [extensionPage, connectionPage, workspacePage],
        onCanExitChange: (canExit) => tab.setClosable(canExit),
        onClose: () => {
          guide = undefined;
          subscriptions.delete(view);
          subscriptions.delete(tab);
          void closed(automatic);
          showNotices();
        },
      });
      guide = { view, tab };
      subscriptions.add(view);
      subscriptions.add(tab);
      tab.reveal();
    };

    subscriptions.add(commands.register('setup.open', () => open(false), { title: t('guideLabel'), category: CommandCategory.help }));

    const step = await native.call('onboarding.take', undefined);
    const status = await native.call('extension.status', undefined);
    if (step === 'setup') {
      open(true);
    } else if (!status.running) {
      open(false);
    } else if (step === 'quickStart') {
      // A folder switch loaded this page again: the guide is done, the quick start follows.
      await startQuickStart();
    }
    if (!guide) {
      showNotices();
    }
  },
};
