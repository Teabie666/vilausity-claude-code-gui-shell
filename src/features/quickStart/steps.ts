/**
 * The quick start's content: groups of steps, each a few lines with the shortcuts it is
 * about and something to try. What Claude Code does in any editor comes first, then what
 * Vilausity adds, then the parts for those who like to tinker (collapsed). Names and keys
 * of the extension's UI are as in Claude Code 2.1.310.
 */

import { SettingsSection } from '../../core/messages';
import { getUiLanguage } from '../../platform/nls';
import { t as localApiT } from '../localApi/messages';
import { t as providersT } from '../providers/messages';
import { t } from './messages';

/** What a step's button does. */
export type StepAction =
  /** Runs a shell command. */
  | { readonly kind: 'command'; readonly command: string; readonly args?: readonly unknown[] }
  /** A new conversation with `prompt` in its input, not sent: what it costs stays the user's call. */
  | { readonly kind: 'prompt'; readonly prompt: () => string }
  /** Opens a web page in the browser. */
  | { readonly kind: 'link'; readonly url: () => string };

export interface QuickStartStep {
  /** Stored once ticked off (quickStart.mark): never rename one. */
  readonly id: string;
  readonly title: () => string;
  /** Paragraphs, separated by blank lines ("\n\n"). */
  readonly body: () => string;
  /** Commands whose current shortcuts are listed under the text, with their titles. */
  readonly keys?: readonly string[];
  readonly action?: StepAction & { readonly label: () => string };
  /** A second button below the first, after a line of its own saying what it is for. */
  readonly extra?: { readonly note: () => string; readonly action: StepAction & { readonly label: () => string } };
  /**
   * Running one of these, from anywhere, ticks the step off. The action ticks it off too;
   * a step with neither is ticked off by hand.
   */
  readonly doneWhen?: readonly string[];
}

export interface QuickStartGroup {
  readonly id: string;
  readonly title: () => string;
  readonly description: () => string;
  /** Closed until opened: the parts most people do not need on day one. */
  readonly collapsed?: boolean;
  readonly steps: readonly QuickStartStep[];
}

const REPOSITORY = 'https://github.com/Teabie666/vilausity-claude-code-gui-shell';

/** The settings at a section: openSection takes its title, in the display language. */
function settings(title: () => string, label: () => string): StepAction & { readonly label: () => string } {
  return {
    kind: 'command',
    command: 'settings.openSection',
    get args() {
      return [title()];
    },
    label,
  };
}

function prompt(text: () => string): StepAction & { readonly label: () => string } {
  return { kind: 'prompt', prompt: text, label: () => t('tryPrompt') };
}

export const QUICK_START_GROUPS: readonly QuickStartGroup[] = [
  {
    id: 'claudeCode',
    title: () => t('groupClaudeCode'),
    description: () => t('groupClaudeCodeText'),
    steps: [
      {
        id: 'send',
        title: () => t('sendTitle'),
        body: () => t('sendBody'),
        keys: ['conversations.new'],
        action: prompt(() => t('sendPrompt')),
      },
      {
        id: 'review',
        title: () => t('reviewTitle'),
        body: () => t('reviewBody'),
        action: prompt(() => t('reviewPrompt')),
      },
      { id: 'modes', title: () => t('modesTitle'), body: () => t('modesBody') },
      { id: 'plan', title: () => t('planTitle'), body: () => t('planBody') },
      {
        id: 'memory',
        title: () => t('memoryTitle'),
        body: () => t('memoryBody'),
        action: prompt(() => t('memoryPrompt')),
        // Other models (DeepSeek) seldom save memories unasked: standing rules in the user's
        // CLAUDE.md, which every conversation reads first, make them.
        extra: {
          note: () => t('memoryBoostNote'),
          action: { kind: 'prompt', prompt: () => t('memoryBoostPrompt'), label: () => t('memoryBoostAction') },
        },
      },
      {
        id: 'rewind',
        title: () => t('rewindTitle'),
        body: () => t('rewindBody'),
        keys: ['conversations.rewind'],
        doneWhen: ['conversations.rewind'],
      },
      {
        id: 'extend',
        title: () => t('extendTitle'),
        body: () => t('extendBody'),
        action: prompt(() => t('extendPrompt')),
      },
    ],
  },
  {
    id: 'vilausity',
    title: () => t('groupVilausity'),
    description: () => t('groupVilausityText'),
    steps: [
      {
        id: 'search',
        title: () => t('searchTitle'),
        body: () => t('searchBody'),
        keys: ['quickOpen.show', 'commandPalette.show'],
        action: { kind: 'command', command: 'quickOpen.show', label: () => t('searchAction') },
        doneWhen: ['quickOpen.show'],
      },
      {
        id: 'sessions',
        title: () => t('sessionsTitle'),
        body: () => t('sessionsBody'),
        keys: ['sessions.toggleSidebar', 'conversations.reopenClosed'],
        action: settings(
          () => SettingsSection.sessions,
          () => t('sessionsAction'),
        ),
      },
      {
        id: 'comments',
        title: () => t('commentsTitle'),
        body: () => t('commentsBody'),
        keys: ['comments.add'],
        doneWhen: ['comments.add'],
      },
      { id: 'drop', title: () => t('dropTitle'), body: () => t('dropBody') },
      { id: 'links', title: () => t('linksTitle'), body: () => t('linksBody') },
      {
        id: 'longChats',
        title: () => t('longChatsTitle'),
        body: () => t('longChatsBody'),
        keys: ['conversations.previousMessage', 'conversations.nextMessage'],
        doneWhen: ['conversations.showFullTranscript'],
      },
      {
        id: 'keys',
        title: () => t('keysTitle'),
        body: () => t('keysBody'),
        keys: ['commandPalette.show', 'keybindings.open'],
        action: { kind: 'command', command: 'keybindings.open', label: () => t('keysAction') },
        doneWhen: ['keybindings.open'],
      },
      {
        id: 'fonts',
        title: () => t('fontsTitle'),
        body: () => t('fontsBody'),
        keys: ['window.zoomIn', 'window.zoomOut', 'window.zoomReset', 'themes.select'],
        action: settings(
          () => SettingsSection.fonts,
          () => t('fontsAction'),
        ),
        doneWhen: ['themes.select'],
      },
      {
        id: 'editor',
        title: () => t('editingTitle'),
        body: () => t('editingBody'),
        keys: ['editor.save', 'markdown.togglePreview', 'contentPane.toggle'],
      },
      {
        id: 'providers',
        title: () => t('providersTitle'),
        body: () => t('providersBody'),
        action: settings(
          () => providersT('settingsSection'),
          () => t('providersAction'),
        ),
      },
    ],
  },
  {
    id: 'more',
    title: () => t('groupMore'),
    description: () => t('groupMoreText'),
    collapsed: true,
    steps: [
      {
        id: 'windows',
        title: () => t('windowsTitle'),
        body: () => t('windowsBody'),
        keys: ['workspace.openRecent', 'workspace.newWindow'],
        doneWhen: ['workspace.newWindow'],
      },
      { id: 'admin', title: () => t('adminTitle'), body: () => t('adminBody') },
      { id: 'explorer', title: () => t('explorerTitle'), body: () => t('explorerBody') },
      { id: 'taskbar', title: () => t('taskbarTitle'), body: () => t('taskbarBody') },
      {
        id: 'stats',
        title: () => t('statsTitle'),
        body: () => t('statsBody'),
        action: { kind: 'command', command: 'stats.show', label: () => t('statsAction') },
        doneWhen: ['stats.show'],
      },
      {
        id: 'localApi',
        title: () => t('localApiTitle'),
        body: () => t('localApiBody'),
        action: settings(
          () => localApiT('section'),
          () => t('localApiAction'),
        ),
      },
      {
        id: 'vibeCoding',
        title: () => t('vibeTitle'),
        body: () => t('vibeBody'),
        action: {
          kind: 'link',
          url: () => `${REPOSITORY}/blob/main/${getUiLanguage() === 'zh-cn' ? 'vibe-coding.md' : 'vibe-coding.en.md'}`,
          label: () => t('vibeAction'),
        },
      },
    ],
  },
];
