/**
 * A conversation's full transcript, as Markdown in the content pane's preview. The
 * conversation page shows a long conversation's last 600 rows only, leaving out its earlier
 * tool calls and thinking (it says so above the first turn, host/webview/omittedRows.ts); the
 * transcript on disk has them all. Main writes it as a file (host/main/fullTranscripts.ts),
 * opened like any Markdown document: again from the right-click menu or the line above the
 * conversation, it is written anew.
 *
 * From the command palette, the conversation's right-click menu (next to the extension's
 * "Rename Session Tab"), and that line.
 */

import { URI } from 'vscode-uri';
import { MenuId } from '../../core/menus';
import type { ShellModule } from '../../core/module';
import { ICommands, IDialogs, IExtensionHost, IMenus, INative, IWebviewFrames } from '../../core/serviceIds';
import { t } from './messages';

const COMMAND = 'conversations.showFullTranscript';
/** The extension's conversation panels (anthropic.claude-code 2.1.310, as its own menu items say). */
const CONVERSATION_PAGE = "webviewId == 'claudeVSCodePanel'";

export const fullTranscriptModule: ShellModule = {
  id: 'fullTranscript',
  activate({ services, subscriptions, logger }) {
    const commands = services.get(ICommands);
    const native = services.get(INative);
    const connection = services.get(IExtensionHost);
    const dialogs = services.get(IDialogs);

    const show = async (): Promise<void> => {
      let file: string | null;
      try {
        file = await native.call('sessions.fullTranscript', {});
      } catch (error) {
        logger.error('writing the full transcript failed', error);
        await dialogs.showMessage({ severity: 'error', message: t('failed', String(error)), modal: false, items: [] });
        return;
      }
      if (!file) {
        await dialogs.showMessage({ severity: 'info', message: t('notFound'), modal: false, items: [] });
        return;
      }
      await connection.rpc?.call('documents.show', { uri: URI.file(file).toString(), preserveFocus: false, preview: false });
    };

    subscriptions.add(
      commands.register(COMMAND, show, { title: t('showFullTranscript'), category: 'Claude', when: 'conversations.hasActive' }),
    );
    subscriptions.add(
      services.get(IMenus).register(MenuId.WebviewContext, { command: COMMAND, title: t('showFullTranscript'), when: CONVERSATION_PAGE }),
    );
    // The line above a conversation whose earlier rows the page leaves out: that conversation is in front.
    subscriptions.add(services.get(IWebviewFrames).onDidRequestFullTranscript(() => void commands.execute(COMMAND)));
  },
};
