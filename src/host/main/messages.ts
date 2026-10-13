/** Text the main process shows: native context menus and error dialogs. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('main', {
  /** The button the shell adds to each row of the session list (sentence case, like the page's own). */
  deleteSession: 'Delete session',
  /** A usage bar's reset time, to the minute ({0}: "15:42", "tomorrow 09:00", "Fri 09:00"...). */
  resetsAt: 'Resets {0}',
  /** On the session list's filter button while sessions wait for the user (like the page's "Active · 3"). */
  needsInput: 'Needs input · {0}',
  /** The session list's usage block, in place of the extension's "Account & usage" ({0}: the API provider). */
  usageTitle: 'Usage · {0}',
  usageTooltip:
    "Estimated with the prices set for this API, from the tokens in Claude Code's transcripts on this computer. Calls Claude Code makes for itself (titles) are not in them.",
  /** The usage block's link to the provider's prices. */
  usagePrices: 'Prices',
  usagePricesTitle: "Set this API's prices",
  usageSession: 'This conversation',
  usageFolder: 'This workspace',
  /** Every session on this computer, whatever ran it (Vilausity, the CLI, VS Code). */
  usageAll: 'Claude Code history',
  /** A row's tooltip, one line per model ({0} input tokens, {1} output, {2} cache reads, {3} cache writes, {4} calls). */
  usageTokens: '{0} input, {1} output, {2} cache read, {3} cache write ({4} calls)',
  usageNoPrice: 'no price',
  usageNone: 'Nothing yet',
  /** {0}: model names. */
  usageUnpriced: 'No price for {0}',
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
