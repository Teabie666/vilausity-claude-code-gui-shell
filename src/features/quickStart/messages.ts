import { defineMessages } from '../../platform/nls';

export const t = defineMessages('quickStart', {
  // The tab and its commands (index.ts)
  editorTitle: 'Quick Start',
  openQuickStart: 'Quick Start',
  deepSeekTitle: 'Get a DeepSeek API Key',
  openDeepSeekGuide: 'Get a DeepSeek API Key',

  // The page (quickStartView.ts)
  heading: 'Quick Start',
  intro:
    'What Claude Code can do, and what Vilausity adds to it. Open a step, read it, and try it. A button that starts a conversation only puts an example in the input box: nothing is sent until you press Enter. (Read it all before you say nobody told you!)',
  safetyTitle: 'Before you start',
  safety1: 'Claude works on your computer for real: it edits files and runs commands in the folder this window shows.',
  safety2: 'In the default mode, Manual, it asks before every edit and every command. Read what it asks.',
  safety3: 'Rewind puts back the files it edited, not what its commands did (installed, deleted, pushed).',
  safety4: 'In an administrator window, a command it runs can change anything on the computer.',
  progress: '{0} of {1} done',
  markDone: 'Mark as done',
  markNotDone: 'Mark as not done',
  noShortcut: 'No shortcut',
  showGroup: 'Show',
  hideGroup: 'Hide',

  // The steps (steps.ts)
  tryPrompt: 'Try in a New Conversation',
  groupClaudeCode: 'Claude Code Basics',
  groupClaudeCodeText: 'What the Claude Code extension does, here as in VS Code.',
  sendTitle: 'Send a message: Hello World!',
  sendBody:
    'Type in the box at the bottom of a conversation. Enter sends, Shift+Enter starts a new line, and Esc stops Claude while it works.\n\nType / for commands and settings (/btw: a quick side question that leaves the conversation as it is; /compact: compact the conversation; /a skill you made; and more). Type @ to mention a file; pictures and files can be pasted or dragged into the box.',
  sendPrompt: 'List what is in this folder, and tell me in a few lines what it seems to be for.',
  reviewTitle: 'Review a change',
  reviewBody:
    'Before Claude edits a file, it asks in the conversation, and the change opens on the right in a diff editor. Accept or reject it there or in the conversation. You can also edit the right side of the diff directly: Claude gets your version.\n\nCommands work the same way: Claude shows the command and waits. Rejecting is fine; Claude asks what to do instead.',
  reviewPrompt: '1. Create a file named hello.md with a short note in it.\n2. Then add another sentence to it.',
  modesTitle: 'Try the modes (Auto is nice, but know your limits)',
  modesBody:
    'The mode at the bottom of the input box. Manual, the default, asks before every edit and every command. Edit automatically edits files without asking, and still asks before commands. Auto lets through what passes a safety check and stops at anything risky. Bypass permissions asks for nothing.\n\nStay on Manual until you know how Claude works in a folder. Use Bypass permissions only in a folder you could afford to lose.',
  planTitle: 'Use Plan mode a lot!',
  planBody:
    'In Plan (the same menu as the modes), Claude reads the code and writes a plan without editing anything. Read it, ask for changes, and approve it when it is right; then Claude starts.\n\nWorth it for anything bigger than a small fix.',
  memoryTitle: 'Let Claude remember you',
  memoryBody:
    "Each conversation starts from nothing, but Claude first reads the CLAUDE.md files, its memory files: the one in the .claude folder of your user folder applies everywhere, the one in the workspace to this folder.\n\nWrite there what Claude should always know: what the project is, how to build and test it, how you want things done (say, no English for me; explain git when you use it, I don't know it). This is Claude Code's greatest feature. You need not write it yourself: Claude can, just tell it to remember, any time.",
  memoryPrompt:
    'Look through this folder and write a CLAUDE.md for it: what it is, how to build and test it, and the conventions to follow.',
  memoryBoostNote:
    'Models other than Claude, such as DeepSeek, hardly write memories at all. Here is a prompt for that: send it once in a new conversation, and yours keeps notes as well as Claude does.',
  memoryBoostAction: 'Put the Prompt in a New Conversation',
  memoryBoostPrompt:
    'Add a section named "Memory" to my user-level CLAUDE.md (usually .claude\\CLAUDE.md in my user folder; create it if there is none). If a section like it is there already, update that one instead of adding another. The section is a standing rule for every conversation from now on:\n\n1. Save without being asked: when I state a preference, correct you, or approve a way of doing something, or when you find out something about a project that is not obvious (how to build it, how to test it, a trap you fell into), save it to memory right away. Do not wait for me to say "remember".\n2. Where: if your system prompt describes a memory directory (auto memory), save there, in the format it gives. Otherwise what is about me goes in this user-level CLAUDE.md, and what is about a project goes in the CLAUDE.md at that project\'s root.\n3. When a project has no CLAUDE.md and you have worked out what it is and how to build and test it, ask me whether to write one.\n4. Keep each memory short: one fact each, with why and how to use it later. Update a memory instead of adding a second one; delete those that are out of date or wrong.\n5. When you finish a task, before you answer me, think about whether something from it should be saved.\n\nWhen you are done, show me the section as written.',
  rewindTitle: 'Take it back?!',
  rewindBody:
    'Press Esc twice in an empty input box (or the shortcut below) and pick one of your messages. The conversation after it is dropped, and the files Claude edited since can be put back as they were.\n\nWhat commands did is not undone: installs, deleted files, git pushes.',
  extendTitle: 'Want more?',
  extendBody:
    'MCP servers give Claude more tools (a browser, a database, control of other programs); skills give it instructions for a kind of task. The easy way to add one is to ask Claude: give it the name or the link, and say whether it is for this folder or for every folder.',
  extendPrompt: 'Which MCP servers and skills do I have set up? Tell me how to add one.',

  groupVilausity: 'Vilausity',
  groupVilausityText: 'What Vilausity adds around the extension.',
  searchTitle: "A search box as capable as VS Code's",
  searchBody:
    "The box in the title bar searches conversations (their titles, what was said, and the files Claude read or changed), files in the workspace and recent folders. Type > first for commands.\n\nIt searches this folder's conversations; Search Conversations in All Folders, at the end of the results, searches the others too. The two buttons beside the box open the workspace in File Explorer and a terminal in it.",
  searchAction: 'Open Search',
  sessionsTitle: 'Manage sessions',
  sessionsBody:
    'The session list is on the left. A click previews a session in a tab that the next click replaces; double-click it, or send a message in it, to keep the tab. The bin button on a row deletes the session for good.\n\nSession Management in the settings sets how long sessions are kept and how far back the list goes.',
  sessionsAction: 'Open Session Management',
  commentsTitle: 'Comment on anything!',
  commentsBody:
    'Select text in a conversation, a file, a diff or a Markdown preview, and press Comment beside it (or the shortcut below). Comments gather above the input box and go to Claude with your next message, each with the text it is about.\n\nA way to point at several places at once without copying them into the message.',
  dropTitle: 'Drag files in',
  dropBody:
    'Dragging files over the window shows what each part does with them. On the session list: copied into the workspace (if they are not in it) and mentioned in the conversation. On the conversation: attached to the message. On the right: opened in the editor.',
  linksTitle: 'Open the files Claude mentions',
  linksBody:
    'File names in a conversation are links: a click opens the file on the right, at the line if there is one. Shift+click opens it in its default program. Right-click to reveal it in File Explorer or copy its path.',
  longChatsTitle: 'Read long conversations with ease',
  longChatsBody:
    "The short lines beside the scroll bar are your messages: point at them for a list, click one to go there. Expanding a thinking block leaves what you are reading where it is.\n\nThe extension shows the last 600 rows of a conversation. View Full Transcript, in the conversation's right-click menu, opens all of it as Markdown.",
  keysTitle: 'Shortcuts for everything!',
  keysBody:
    'The command palette lists every command with its shortcut. Keyboard Shortcuts in the settings changes them: double-click a row and press the new keys. Set them to the keys you are used to, as freely as in VS Code.',
  keysAction: 'Open Keyboard Shortcuts',
  fontsTitle: 'A better-looking Vilausity? Fonts, zoom and theme',
  fontsBody:
    "Fonts in the settings sets the interface, the conversation, the code in conversations and the editor separately, each with its size. Zoom changes everything at once, in every window.\n\nColor Theme picks one of VS Code's themes. The accent color follows the window's API provider unless you choose one.",
  fontsAction: 'Open Fonts',
  editingTitle: 'Edit files on the right',
  editingBody:
    'Files, diffs and previews open in the content pane on the right, in the editor VS Code uses. Files: Auto Save in the settings saves without Ctrl+S. A Markdown file switches between its source and a preview.',
  providersTitle: 'Several API providers, in color',
  providersBody:
    "Each window talks to one API provider, or to a Claude account; the button on the left of the title bar switches it for new conversations. A window takes its provider's color, so windows on different providers are easy to tell apart.\n\nThe usage block above the session list shows what conversations cost, worked out from the provider's prices. The colored square beside the session filters hides other providers' sessions.",
  providersAction: 'Open API Providers',

  groupMore: 'Advanced',
  groupMoreText: 'Not needed on day one.',
  windowsTitle: 'Several windows',
  windowsBody:
    'Each window shows one folder, with its own conversations and API provider. Open Recent switches this window to another folder (Ctrl+Enter there opens it in a new window); New Window opens one beside it.',
  adminTitle: 'Administrator window',
  adminBody:
    'Open This Folder as Administrator, in Open Recent, starts a second Vilausity with administrator rights; its title says [Administrator]. Commands Claude runs there can change anything on the computer: use it with care.',
  explorerTitle: 'File Explorer menu',
  explorerBody:
    "Open with Vilausity, in File Explorer's right-click menu, opens a folder in Vilausity (on Windows 11, under Show more options). File Explorer: Context Menu in the settings adds or removes it.",
  taskbarTitle: 'Taskbar',
  taskbarBody:
    'The taskbar button shows a moving bar while a conversation works, and turns yellow when one waits for you (a permission, a question). In the window, the logo in the title bar blinks or stays amber.',
  statsTitle: 'Statistics',
  statsBody:
    "What Claude Code's transcripts add up to: conversations, messages, tokens, what each provider cost, disk space. Also under About in the settings.",
  statsAction: 'Show Statistics',
  localApiTitle: 'Local API',
  localApiBody:
    'Programs on this computer (scripts, bots, hotkey tools) can see what the windows and conversations are doing and open folders, files and conversations, over a local HTTP API. Off until you turn it on.',
  localApiAction: 'Open Local API',
  vibeTitle: 'Want more features? Rework Vilausity yourself',
  vibeBody:
    'Vilausity is open source. To add what you miss, open its source in Vilausity and have Claude change it; the guide in the repository goes through it.',
  vibeAction: 'Open the Guide',

  // The DeepSeek key guide (deepSeekView.ts)
  dsIntro:
    "DeepSeek's API is pay as you go: you top up a balance on its platform, and each request takes what its tokens cost. Getting a key takes a few minutes.",
  dsSignInTitle: 'Sign in to the DeepSeek platform',
  dsSignInBody: 'Open platform.deepseek.com and sign in with your phone number (a code by SMS) or WeChat. A new number gets an account.',
  dsOpenPlatform: 'Open the Platform',
  dsVerifyTitle: 'Verify your identity, if asked',
  dsVerifyBody: 'The platform may ask for real-name verification before you top up or create a key. Its own page goes through it.',
  dsTopUpTitle: 'Top up',
  dsTopUpBody:
    'Requests are paid from the balance; with nothing left they fail, and the connection test in the setup guide says the account has no balance. Top up on the Top up page. The pricing page lists what each model costs.',
  dsCreateTitle: 'Create an API key',
  dsCreateBody:
    'On the API keys page, create a key and give it a name you will recognize, such as Vilausity. The key is shown once: copy it right away. If it is lost, delete it there and create another.',
  dsPasteTitle: 'Paste it into Vilausity',
  dsPasteBody:
    'Back in the setup guide, on the Connection page: I have an API key, DeepSeek as the API provider (chosen at first), OK, then paste the key and save it. Test checks it with a request of one token. Vilausity keeps the key encrypted for this Windows user and gives it only to Claude Code.',
  dsUsageTitle: 'Keep an eye on what it costs',
  dsUsageBody:
    "The usage block above the session list adds up what this window's conversations cost, from the provider's prices. The platform's Usage page has the exact amounts, by day and by model.",
  dsKeepSafe: 'Keep the key to yourself: anyone who has it can spend your balance. If it leaks, delete it on the API keys page.',
});
