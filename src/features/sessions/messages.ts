/** Text of the session list sidebar. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('sessions', {
  loading: 'Loading sessions…',
  noSessionList: 'This version of Claude Code has no session list.',
  sessions: 'Sessions',
  toggleSessionList: 'Toggle Session List',
  /** A session without a title, in the messages below. */
  untitled: 'Untitled',
  deleteTitle: 'Delete the session "{0}" for good?',
  deleteDetail: 'Its conversation is deleted from this computer and cannot be brought back.',
  /**
   * Below it when the session ran under a compatible API ({0}: the APIs, each as `deleteCostItem`
   * or its name alone when it has no prices).
   */
  deleteCost: "What it cost on {0} also goes from the usage in the session list. The API's total in its settings keeps counting it.",
  /** {0}: an API's name, {1}: what the session cost on it ("¥1.23"). */
  deleteCostItem: '{0} ({1})',
  /** Between two APIs in `deleteCost`. */
  deleteCostSeparator: ', ',
  delete: 'Delete',
  deleteElsewhere:
    'The session "{0}" is in use elsewhere: in another window, in VS Code or on the command line. Close it there first, then delete it.',
  deleteNotFound: 'The session "{0}" was not found on this computer.',
  deleteFailed: 'The session "{0}" could not be deleted. See the log for details.',
});
