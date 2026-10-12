/** Text of the window commands and of the title bar's logo. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('window', {
  logoWorking: 'Claude is working',
  logoWorkingIn: 'Claude is working in {0} conversations',
  logoWaiting: 'Claude needs your input',
  logoWaitingIn: '{0} conversations need your input',
  closeWindow: 'Close Window',
  quit: 'Exit',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  resetZoom: 'Reset Zoom',
  toggleDevTools: 'Toggle Developer Tools',
  showSampleNotifications: 'Show Sample Notifications',
  sampleInfo: 'Sample information notification. One with buttons stays until a button or × is clicked.',
  sampleWarning: 'Sample warning. One without buttons closes by itself after a while.',
  sampleError: 'Sample error with a longer message, to show how the text wraps across lines and how the buttons line up below it.',
  sampleAction: 'Action',
  sampleLater: 'Later',
});
