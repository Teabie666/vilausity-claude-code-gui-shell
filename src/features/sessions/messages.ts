/** Text of the session list sidebar. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('sessions', {
  loading: 'Loading sessions…',
  noSessionList: 'This version of Claude Code has no session list.',
  sessions: 'Sessions',
  toggleSessionList: 'Toggle Session List',
  toggleTooltip: 'Toggle Session List (Ctrl+B)',
  /** A session without a title, in the messages below. */
  untitled: 'Untitled',
  deleteTitle: 'Delete the session "{0}" for good?',
  deleteDetail: 'Its conversation is deleted from this computer and cannot be brought back.',
  delete: 'Delete',
  deleteElsewhere:
    'The session "{0}" is in use elsewhere: in another window, in VS Code or on the command line. Close it there first, then delete it.',
  deleteNotFound: 'The session "{0}" was not found on this computer.',
  deleteFailed: 'The session "{0}" could not be deleted. See the log for details.',
});
