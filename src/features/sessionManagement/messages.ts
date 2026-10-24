/** Text of the session management section of the settings. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('sessionManagement', {
  deleteAfterSetting:
    "Claude Code deletes the conversations left alone for longer than this, each time it starts. It is Claude Code's own setting (cleanupPeriodDays in ~/.claude/settings.json): the command line and VS Code delete them too.",
  never: 'Never',
  days: '{0} days',
  showWithinSetting:
    'The session list shows only the conversations active within this time. Older ones are hidden, not deleted: the search (Ctrl+P) still finds them.',
  all: 'All',
  /** {0}: how many; {1}: how much room, "482 MB". */
  storage: 'Conversation transcripts on this computer: {0} · {1}',
  storageLoading: 'Conversation transcripts on this computer: counting…',
  openFolder: 'Open Folder',
  deleteArchived: 'Delete Archived Conversations…',
  /** {0}: the days Claude Code's settings say. */
  ownValue:
    "Claude Code's settings.json sets cleanupPeriodDays to {0} days itself (not Vilausity): it is kept, and the setting below does not change it.",
  openClaudeSettings: 'Open settings.json',
  noArchived: 'There are no archived conversations in this folder.',
  /** {0}: how many. */
  confirmDeleteArchived:
    'Delete the {0} archived conversations of this folder for good? They cannot be brought back. Conversations in use elsewhere (another window, VS Code, the command line) are kept.',
  delete: 'Delete',
  /** {0}: how many were deleted, {1}: how many are in use elsewhere. */
  deletedArchived: 'Deleted {0} conversations. {1} in use elsewhere were kept.',
  deletedAllArchived: 'Deleted {0} conversations.',
  keywords: 'sessions conversations delete archive storage disk size cleanupPeriodDays',
});
