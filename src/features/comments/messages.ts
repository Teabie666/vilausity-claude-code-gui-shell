/** Text of the comments feature: the selection button, the comment form, the blocks above the input (the page's button: main's messages). */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('comments', {
  comment: 'Comment',
  addComment: 'Add Comment',
  addCommentTooltip: 'Add Comment (Enter)',
  saveTooltip: 'Save (Enter)',
  cancelTooltip: 'Cancel (Escape)',
  addCommentCommand: 'Add Comment on Selection',
  clearComments: 'Clear Comments',
  save: 'Save',
  cancel: 'Cancel',
  placeholder: 'Add your feedback for Claude',
  editComment: 'Edit Comment',
  deleteComment: 'Delete Comment',
  clearAll: 'Clear All Comments',
  oneComment: '1 comment',
  manyComments: '{0} comments',
  sentWithNextMessage: 'Sent with your next message',
  showComments: 'Show Comments',
  hideComments: 'Hide Comments',
  goTo: 'Go to {0}',
  selectText: 'Select text in an editor, a preview or the conversation to comment on it.',
  /** Where commented text of the conversation is (a block's source, the form's). */
  claudesReply: "Claude's reply",
  claudesThinking: "Claude's thinking",
  yourMessage: 'Your message',
  /** The tooltip of such a source: a click scrolls to the text and flashes it. */
  showInConversation: 'Show in the conversation',
});
