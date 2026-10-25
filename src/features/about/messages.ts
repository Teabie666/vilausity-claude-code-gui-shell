import { defineMessages } from '../../platform/nls';

export const t = defineMessages('about', {
  section: 'About',
  keywords: 'about version update github releases electron chromium node',
  extension: 'Claude Code extension {0}',
  noExtension: 'No Claude Code extension installed',
  checking: 'Checking for a newer version...',
  fetchFailed: 'Could not check for a newer version',
  retry: 'Retry',
  newer: 'A newer version is available: {0}',
  upToDate: 'Up to date',
  repository: 'GitHub Repository',
  releases: 'Releases',
  statistics: 'Statistics',
  setupGuide: 'Setup Guide',
  quickStart: 'Quick Start',
  copy: 'Copy Version Information',
  copied: 'Copied.',
});
