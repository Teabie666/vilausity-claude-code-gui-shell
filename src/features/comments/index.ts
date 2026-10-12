/**
 * Comments on selected text for Claude, like the extension's plan comments but anywhere in
 * the content pane: select text in an editor, a diff or a Markdown preview, click Comment
 * (or Ctrl+Alt+M), write it; it shows above the conversation's input and goes out with the
 * next message. See docs/ARCHITECTURE.md ("评论").
 */

import type { EditorSelectionContext } from '../../core/editors';
import { MenuId } from '../../core/menus';
import type { ShellModule } from '../../core/module';
import { ICommands, IContextKeys, IDialogs, IExtensionHost, IKeybindings, ILayout, IMenus, IWebviewFrames } from '../../core/serviceIds';
import { IContentPane } from '../contentPane';
import { IConversations } from '../conversations';
import { CommentsController } from './comments';
import { t } from './messages';

function isSelectionContext(value: unknown): value is EditorSelectionContext {
  const context = value as Partial<EditorSelectionContext> | null;
  return (
    typeof context === 'object' && context !== null && typeof context.showWidget === 'function' && typeof context.selection === 'object'
  );
}

export const commentsModule: ShellModule = {
  id: 'comments',
  dependsOn: ['conversations', 'contentPane', 'editor'],
  activate({ services, subscriptions, logger }) {
    const contentPane = services.get(IContentPane);
    const contextKeys = services.get(IContextKeys);
    const controller = subscriptions.add(
      new CommentsController(
        services.get(IExtensionHost),
        services.get(IWebviewFrames),
        services.get(IConversations),
        contentPane,
        services.get(ILayout),
        logger,
      ),
    );
    const updateContext = (): void => contextKeys.set('comments.hasComments', controller.activeComments.length > 0);
    subscriptions.add(controller.onDidChange(updateContext));
    updateContext();

    const commands = services.get(ICommands);
    const register = [
      commands.register(
        'comments.add',
        async (argument) => {
          // From the selection's buttons with its context; from a keybinding, the focused tab's selection.
          const context = isSelectionContext(argument) ? argument : contentPane.current?.pane.selectionContext?.();
          if (context) {
            controller.add(context);
          } else {
            await services.get(IDialogs).showMessage({ severity: 'info', message: t('selectText'), modal: false, items: [] });
          }
        },
        { title: t('addCommentCommand'), category: 'Claude', when: 'conversations.hasActive' },
      ),
      commands.register('comments.clear', () => controller.clearActive(), {
        title: t('clearComments'),
        category: 'Claude',
        when: 'comments.hasComments',
      }),
      services.get(IMenus).register(MenuId.EditorSelection, {
        command: 'comments.add',
        title: t('comment'),
        icon: 'comment',
        group: 'navigation',
        when: 'conversations.hasActive',
      }),
      services.get(IKeybindings).register({ key: 'ctrl+alt+m', command: 'comments.add' }),
    ];
    register.forEach((disposable) => subscriptions.add(disposable));
  },
};
