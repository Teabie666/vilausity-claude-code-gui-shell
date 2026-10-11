/** Text of the core workbench: dialogs, quick access, window regions, startup failure. */

import { defineMessages } from '../platform/nls';

export const t = defineMessages('core', {
  inputBoxHint: "{0} (Press 'Enter' to confirm or 'Escape' to cancel)",
  close: 'Close',
  ok: 'OK',
  cancel: 'Cancel',
  open: 'Open',
  confirmOpenUri: "Allow '{0}' to open this link?",
  openConversations: 'Open conversations',
  sessions: 'Sessions',
  startupFailed: 'Vilausity failed to start: {0}',
  categoryView: 'View',
  categoryDeveloper: 'Developer',
  categoryPreferences: 'Preferences',
  categoryFile: 'File',
  sectionWorkbench: 'Workbench',
  quickAccess: 'Search and commands',
  searchPlaceholder: 'Search conversations, files and folders (type > for commands)',
});

/** Sections of the settings editor that several modules add to. */
export const SettingsSection = {
  get workbench(): string {
    return t('sectionWorkbench');
  },
};

/** Command palette categories that several modules use, named as in VS Code. */
export const CommandCategory = {
  get file(): string {
    return t('categoryFile');
  },
  get view(): string {
    return t('categoryView');
  },
  get developer(): string {
    return t('categoryDeveloper');
  },
  get preferences(): string {
    return t('categoryPreferences');
  },
};
