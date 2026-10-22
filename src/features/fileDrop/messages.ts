/** Text of dropping files onto the window: the labels of its places, the setting, errors. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('fileDrop', {
  /** The session list. */
  mention: 'Mention in the conversation',
  /** {0}: the folder in the workspace, e.g. "attachments" (files already in the workspace are not copied). */
  mentionDetail: 'Copy to workspace/{0} and mention in the conversation',
  /** The conversation: the extension attaches them (images, PDFs, text). */
  attach: 'Upload to the message as an attachment',
  open: 'Open in the editor',
  attachmentsFolderSetting:
    'Folder of the workspace that files dropped onto the session list are copied to when they are outside the workspace; the conversation mentions the copies. Relative to the workspace folder.',
  /** {0}: the files, one per line. */
  copyFailed: 'These could not be copied into the workspace:\n{0}',
  /** {0}: the file. */
  openFailed: 'Cannot open {0}.',
});
