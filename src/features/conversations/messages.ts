/** Text of the conversations feature: its commands, the tabs, the empty state and find. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('conversations', {
  newConversation: 'New Conversation',
  closeConversation: 'Close Conversation',
  reopenClosedConversation: 'Reopen Closed Conversation',
  nextConversation: 'Next Conversation',
  previousConversation: 'Previous Conversation',
  /** `{0}`: its place in the row of tabs, from 1. */
  openConversationAt: 'Open Conversation {0}',
  focusInput: 'Focus Input',
  interrupt: 'Interrupt Claude',
  rewind: 'Rewind to…',
  findInConversation: 'Find in Conversation',
  previousMessage: 'Go to Previous Message of Yours',
  nextMessage: 'Go to Next Message of Yours',
  messageMarkersSetting:
    "Show a marker for each of your messages by the conversation's scrollbar; pointing at them lists the messages, a click goes to one.",
  showLogs: 'Show Logs',
  signOut: 'Sign Out',
  noConversation: 'No conversation open',
  close: 'Close',
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
