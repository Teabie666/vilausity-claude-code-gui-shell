/** Text the main process shows: native context menus and error dialogs. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('main', {
  /** The button the shell adds to each row of the session list (sentence case, like the page's own). */
  deleteSession: 'Delete session',
  /** A usage bar's reset time, to the minute ({0}: "15:42", "tomorrow 09:00", "Fri 09:00"...). */
  resetsAt: 'Resets {0}',
  /** On the session list's filter button while sessions wait for the user (like the page's "Active · 3"). */
  needsInput: 'Needs input · {0}',
  /** File Explorer's context menu, on a folder, a folder's background or a drive. */
  explorerOpen: 'Open with Vilausity',
  explorerOpenAsAdministrator: 'Open with Vilausity (Administrator)',
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select All',
  openLink: 'Open Link in Browser',
  copyLink: 'Copy Link Address',
  extensionDirInvalid: 'There is no Claude Code extension in {0} (--extension-dir).',
  extensionFailedToStart: 'Claude Code failed to start',
  rollBackOffer: 'Claude Code {0} has not worked here before. Go back to {1}, the version used before it?',
  rollBackAndRestart: 'Go Back to {0} and Restart',
  close: 'Close',
  installVsixTitle: 'Install Claude Code from a VSIX File',
  administratorTitle: '{0} [Administrator]',
  vsixFiles: 'VSIX Packages',
  extensionHostExited: 'Exit code {0}. Logs: {1}',
});
