/**
 * Packaging with electron-builder, which loads this file with jiti (TypeScript as is):
 *   npm run package       production build, then release/win-unpacked/ and the NSIS installer
 *   npm run package:dir   production build, then release/win-unpacked/ only (quicker, for testing)
 */

import type { Configuration } from 'electron-builder';
import { APP_ID } from './src/platform/product';

const config: Configuration = {
  appId: APP_ID,
  productName: 'Vilausity',
  copyright: 'Copyright (C) 2026 Teabie',
  directories: { output: 'release', buildResources: 'build' },
  // esbuild bundles everything the app runs into dist/ (scripts/build.mjs), so node_modules
  // holds build tools only: package.json lists every package under devDependencies, and
  // electron-builder adds none of them.
  files: ['package.json', 'dist/**/*', '!dist/**/*.map', '!dist/ThirdPartyNotices.txt'],
  // Next to the program, where people look for them.
  extraFiles: [
    { from: 'LICENSE', to: 'LICENSE.txt' },
    { from: 'dist/ThirdPartyNotices.txt', to: 'ThirdPartyNotices.txt' },
  ],
  // Electron's version comes from node_modules/electron, and so does its zip: npm's install of
  // electron downloaded it into the same cache (%LOCALAPPDATA%\electron\Cache). Not
  // `electronDist`: with an unpacked Electron, electron-builder leaves default_app.asar in.
  asar: true,
  electronFuses: {
    // Started from a terminal of VS Code or VSCodium, the program would inherit
    // ELECTRON_RUN_AS_NODE and run as plain Node; nothing in the app or the extension relies
    // on it (the extension host is a utilityProcess, and the extension never forks).
    runAsNode: false,
    onlyLoadAppFromAsar: true,
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'resources/icon/icon.ico',
    executableName: 'Vilausity',
  },
  nsis: {
    artifactName: 'Vilausity-Setup-${version}.${ext}',
  },
  // Released by hand on GitHub; no update feed.
  publish: null,
};

export default config;
