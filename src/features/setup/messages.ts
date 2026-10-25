import { defineMessages } from '../../platform/nls';

export const t = defineMessages('setup', {
  // The guide
  guideLabel: 'Setup Guide',
  guideStep: 'Step {0} of {1}: {2}',
  guideBack: 'Back',
  guideSkip: 'Skip This Page',
  guideNext: 'Next',
  guideFinish: 'Finish',
  guideExit: 'Exit Guide',
  // Page 1: the extension
  extPageTitle: 'Extension',
  extTitle: 'Claude Code extension',
  extText:
    'Vilausity runs the Claude Code extension that Anthropic publishes for VS Code. If VS Code or VSCodium on this computer has it installed, that copy is used.',
  extDownload: 'Download and Install',
  extInstallFile: 'Install from VSIX...',
  extFailedHelp:
    'If it keeps failing, try another download server below, or download the .vsix in a browser and install it with Install from VSIX...:',
  extOpenVsxPage: 'the Claude Code page on Open VSX',
  extInstalled: 'Claude Code {0} is installed.',
  extStarting: 'Claude Code {0} is installed. Starting it...',
  extExternal:
    "This copy was installed by {0}. Vilausity does not change it; once a new version is out, Vilausity downloads its own copy, and automatic updates and going back are then Vilausity's.",
  extCli: 'This copy was given with --extension-dir. It is used as it is, and no updates are checked for.',
  extUpdates: 'Claude Code Extension Updates',
  extAutoUpdate: 'Automatic updates',
  extAutoUpdateText: 'A new version is used from the next start; the one before it is kept, to go back to.',
  extPinned: 'Stay on a version',
  extPinnedText: 'For example 2.1.282, installed from Open VSX if needed, older or newer. Empty follows the newest.',
  extServer: 'Download server',
  extServerText: 'There is no public mirror in mainland China; enter only your own Open VSX server, or one you trust.',
  extServerOfficial: 'Open VSX (official)',
  extServerCustom: 'Custom address',
  // Page 2: the connection
  connPageTitle: 'Connection',
  connTitle: 'Connect to Claude',
  connText: 'Conversations in this window go to one service. Change it whenever you like from the button on the left of the title bar.',
  connUses: 'This window uses {0}.',
  connNext: 'Next',
  connSetUpAnother: 'Set Up Another',
  connChoiceKey: 'I have an API key',
  connChoiceKeyText: 'DeepSeek, Kimi, GLM, Qwen, an Anthropic API key and more',
  connChoiceNoKey: "I don't have one yet",
  connChoiceNoKeyText: 'Opens a guide to getting a DeepSeek API key; come back to this page with the key',
  connChoiceAccount: 'Sign in with a Claude account',
  connChoiceAccountText: 'Claude Pro or Max; the sign-in shows up in a conversation',
  connBack: 'Back to the choices',
  connProvider: 'API Provider',
  connProviderText: 'Every provider comes with its address, models and prices filled in.',
  connProviderOk: 'OK',
  connChange: 'Change',
  connKey: 'API key',
  connKeyText: 'The key is stored encrypted on this computer and given only to Claude Code.',
  connSetupGuide: 'Setup guide',
  connModels: 'Models',
  connModelsText:
    'Main model is what conversations use by default. Opus, Sonnet and Haiku are the three choices of the model picker in a conversation, and Subagents is what Claude sends its own subagents to. A name ending in [1m] has a context of 1 million tokens. The preset has filled these in: leave them as they are unless you know the model names.',
  connPrices: 'Prices',
  connPricesText: 'Prices work out what the conversations on this API cost; the session list shows the total at the top.',
  connPricesAi:
    'Token prices change often. To fill them in, copy the prompt, send it to an AI chat that can search the web, and paste its whole answer back.',
  connPricesAiDated:
    'Token prices change often; the ones the {0} preset comes with were read on {1}. To bring them up to date, copy the prompt, send it to an AI chat that can search the web, and paste its whole answer back.',
  connPricesShow: 'Show Prices',
  connPricesHide: 'Hide Prices',
  connTest: 'Test',
  connTestText:
    'Sends a request of one token with this key, to see whether it connects. Save the key first: its row has a button of its own.',
  connDefaultProvider: 'Set as default API provider',
  connAddFailed: 'Could not add the provider: {0}',
  connRemoveFailed: 'Could not remove the provider: {0}',
  connSwitchFailed: 'Could not switch to the Claude account: {0}',
  // Page 3: the workspace
  wsTitle: 'Workspace',
  wsIntro:
    'Claude reads and writes files, and runs commands, in the workspace: the folder this window has open. Sessions are kept per folder, and the search box in the title bar shows the workspace in use.',
  wsChange:
    'To work in another folder, press {0}, or right-click a folder in File Explorer and choose "Open with Vilausity". That item can be turned off in the settings.',
  wsFolder: 'Workspace folder',
  wsBrowse: 'Browse...',
  wsHomeHint:
    "This is your user folder, the global workspace: Claude can reach everything under it, which suits odd jobs. For a project, switch to the project's folder.",
  wsOpenedElsewhere: 'This folder is already open in another window.',
  wsNotFound: 'This folder could not be found.',
  // Notices
  gitMissing:
    'Git for Windows was not found. Claude Code uses Git to track changes and Git Bash to run commands; without it, Claude runs commands in PowerShell.',
  downloadGit: 'Download Git for Windows',
  dontShowAgain: "Don't Show Again",
});
