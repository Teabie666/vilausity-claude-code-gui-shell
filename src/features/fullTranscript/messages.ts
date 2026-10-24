/** Text of the full transcript command. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('fullTranscript', {
  showFullTranscript: 'View Full Transcript',
  notFound: 'There is no transcript of this conversation yet: Claude Code writes it once the first message is sent.',
  failed: 'The full transcript could not be written: {0}',
});
