/** Text of the title bar's search box and the files it finds. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('quickOpen', {
  search: 'Search...',
  searchTooltip: 'Search conversations, files and folders ({0})',
  /** The search box: the window's folder. */
  workspaceLabel: 'Workspace: {0}',
  /** After the folder's name in the administrator instance (VS Code's title says the same). */
  administrator: '[Administrator]',
  administratorTooltip:
    'This instance runs as administrator: Claude can change what needs administrator rights. It has windows and state of its own; settings and API providers are shared with the normal instance.',
  files: 'Files',
  cannotOpen: 'Cannot open {0}.',
});
