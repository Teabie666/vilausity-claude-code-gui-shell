/** Text of dropping files onto the window: the labels of its places, the setting, errors. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('fileDrop', {
  /** The session list and the search box. */
  mention: 'Mention in the conversation',
  /** {0}: the folder, e.g. "attachments". */
  mentionDetail: 'Files from outside the workspace are copied to {0} first',
  /** The conversation: the extension attaches them (images, PDFs, text). */
  attach: 'Attach to your message',
  open: 'Open in the editor',
  attachmentsFolderSetting:
    'Folder of the workspace that files dropped onto the session list or the search box are copied to when they are outside the workspace; the conversation mentions the copies. Relative to the workspace folder.',
  /** {0}: the files, one per line. */
  copyFailed: 'These could not be copied into the workspace:\n{0}',
  /** {0}: the file. */
  openFailed: 'Cannot open {0}.',
});
