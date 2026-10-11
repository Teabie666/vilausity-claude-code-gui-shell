/** Text of the conversations feature: its commands, the tabs, the empty state and find. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('conversations', {
  newConversation: 'New Conversation',
  closeConversation: 'Close Conversation',
  reopenClosedConversation: 'Reopen Closed Conversation',
  focusInput: 'Focus Input',
  findInConversation: 'Find in Conversation',
  showLogs: 'Show Logs',
  signOut: 'Sign Out',
  noConversation: 'No conversation open',
  closeTab: 'Close (Ctrl+W)',
  closeTabLabel: 'Close conversation',
  alwaysShowTabsSetting:
    'Show the conversation tabs even with one conversation open. Off: the row of tabs appears once a second conversation opens.',
  find: 'Find',
  matchCase: 'Match Case (Alt+C)',
  previousMatch: 'Previous Match (Shift+Enter)',
  nextMatch: 'Next Match (Enter)',
  closeFind: 'Close (Escape)',
  noResults: 'No results',
  matchPosition: '{0} of {1}',
});
