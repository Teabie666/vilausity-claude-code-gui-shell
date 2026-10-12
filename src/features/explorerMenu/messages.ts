/** Text of the File Explorer menu switch in the settings. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('explorerMenu', {
  category: 'File Explorer',
  name: 'Context Menu',
  description:
    'Show "Open with Vilausity" and "Open with Vilausity (Administrator)" when you right-click a folder, the empty space in a folder or a drive in File Explorer, to open it as the workspace. For this Windows user only. In the Windows 11 menu they are under "Show more options".',
  /** What the settings search finds the switch by, besides its title and description. */
  keywords: 'explorer context menu right-click open with folder administrator shell integration',
  failed: "File Explorer's menu could not be changed. See the log for details.",
});
