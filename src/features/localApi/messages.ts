/** Text of the local API's settings. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('localApi', {
  section: 'Local API',
  enabledSetting:
    'Let programs on this computer use the local API: see the windows and what each conversation is doing, open folders, files and conversations, and run commands. Only programs that read the key in api.json get in.',
  allowSendSetting:
    'Programs that use the local API may also send messages to Claude. When off, they can only put a message in the input for you to send.',
  portSetting: "The local API's port. 0 lets the system pick a free one; api.json says which.",
  off: 'Off',
  running: 'Running at {0}',
  runningReadOnly: 'Running at {0} (read-only in the administrator instance)',
  failed: 'Not running: {0}',
  keyFile: 'Address and key: {0}',
  showKeyFile: 'Show api.json',
  docs: 'Documentation',
  /** What the settings search finds the section by. */
  keywords: 'api http local automation script program remote',
});
