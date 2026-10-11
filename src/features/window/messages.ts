/** Text of the window commands. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('window', {
  closeWindow: 'Close Window',
  quit: 'Exit',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  resetZoom: 'Reset Zoom',
  toggleDevTools: 'Toggle Developer Tools',
  showSampleNotifications: 'Show Sample Notifications',
  sampleInfo: 'Sample information notification. One with buttons stays until a button or × is clicked.',
  sampleWarning: 'Sample warning. One without buttons closes by itself after a while.',
  sampleError:
    'Sample error with a longer message, to show how the text wraps across lines and how the buttons line up below it.',
  sampleAction: 'Action',
  sampleLater: 'Later',
  administrator: 'Administrator',
  administratorTooltip:
    'This instance runs as administrator: Claude can change what needs administrator rights. It has windows and state of its own; settings and API providers are shared with the normal instance.',
});
