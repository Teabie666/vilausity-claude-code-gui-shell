/** Text of the workspace folder: the commands that open folders and the folders in the search. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('workspace', {
  openFolder: 'Open Folder...',
  openFolderInNewWindow: 'Open Folder in New Window...',
  openRecent: 'Open Recent...',
  newWindow: 'New Window',
  revealFolder: 'Reveal Folder in File Explorer',
  openTerminal: 'Open Terminal in Workspace',
  terminalFailed: 'Could not open a terminal.',
  terminalSetting:
    'The terminal to open in the workspace folder: the path of its program. Empty: Windows Terminal when it is installed, else PowerShell.',
  openAsAdministrator: 'Open This Folder as Administrator',
  recent: 'recent',
  browse: 'Browse...',
  pickToOpen: 'Select a folder to open (Ctrl+Enter: in a new window)',
  pickForNewWindow: 'Select a folder to open in a new window',
  openElsewhere: 'open in another window',
  folders: 'Folders',
  replaceTitle: 'Open {0} in this window?',
  replaceDetail: 'The conversations and files open here close. They come back when you open {0} again.',
  open: 'Open',
  openInNewWindow: 'Open in New Window',
  folderMissing: 'The folder {0} does not exist.',
  /** The user's home folder: as a workspace, Claude works across the whole computer. */
  globalFolder: '{0} (global)',
});
