/** Text of the unsaved-files question when a window closes or the app quits. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('windowClose', {
  saveChangesQuestionOne: 'Do you want to save the changes you made to {0}?',
  saveChangesQuestion: 'Do you want to save the changes to the following {0} files?',
  saveAll: 'Save All',
  dontSave: "Don't Save",
  saveFailed: 'Could not save all the changes.',
  saveFailedDetail: 'Some files could not be saved (read-only, for example), so the window stays open.',
});
