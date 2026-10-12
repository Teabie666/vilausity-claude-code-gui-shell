/**
 * Electron main entry point. Keeps to startup order only; the real work is in ShellApp.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, Menu } from 'electron';
import { parse } from 'jsonc-parser';
import { setUnexpectedErrorHandler } from '../../platform/event';
import { targetPlatformOf } from '../../platform/extensionUpdates';
import { Logger, LogLevel, NullLogger, parseLogLevel } from '../../platform/log';
import { LANGUAGE_SETTING, resolveUiLanguage, setUiLanguage } from '../../platform/nls';
import { APP_ID } from '../../platform/product';
import { languagePack } from '../../nls/packs';
import { FileLogSink } from '../node/fileLogSink';
import { createAppPaths, pruneOldLogs, type AppPaths } from './appPaths';
import { registerCcwSchemePrivileges } from './ccwProtocol';
import { HELP_TEXT, parseCliArgs, userArguments, type CliArgs } from './cli';
import { administratorInstanceArgs, isElevated, startElevated } from './elevation';
import { ExplorerMenu, explorerMenuRoot } from './explorerMenu';
import { locateClaudeExtension } from './extensionLocator';
import { ExtensionStore } from './extensionStore';
import { shareSafeStorageKey } from './safeStorageKey';
import { explorerMenuLabels, explorerMenuTarget, ShellApp } from './shellApp';

/** What a second start hands to the running instance (Electron's `additionalData`). */
interface SecondStart {
  readonly argv: readonly string[];
  readonly cwd: string;
}

function isSecondStart(value: unknown): value is SecondStart {
  const data = value as Partial<SecondStart> | null;
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof data.cwd === 'string' &&
    Array.isArray(data.argv) &&
    data.argv.every((arg) => typeof arg === 'string')
  );
}

function versionText(args: CliArgs, paths: AppPaths): string {
  const store = new ExtensionStore(paths.extensionsDir, targetPlatformOf(process.platform, process.arch), NullLogger);
  const extension = locateClaudeExtension(args.extensionDir, store.currentCopy(), !args.ignoreOtherEditors);
  return [
    `Vilausity ${app.getVersion()}`,
    `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}`,
    extension ? `Claude Code ${extension.version} (${extension.path})` : 'Claude Code: not found',
    '',
  ].join('\n');
}

/**
 * The installer's option: adds (or removes) File Explorer's entries, labeled in the display
 * language the settings ask for (or the system's), and quits.
 */
async function changeExplorerMenu(register: boolean, settingsFile: string): Promise<void> {
  await app.whenReady();
  const menu = new ExplorerMenu(explorerMenuRoot(process.env), explorerMenuTarget());
  if (!register) {
    await menu.unregister();
    return;
  }
  let setting: unknown;
  try {
    setting = (parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown> | undefined)?.[LANGUAGE_SETTING];
  } catch {
    // No settings yet: the system's language.
  }
  const language = resolveUiLanguage(setting, app.getPreferredSystemLanguages());
  setUiLanguage(language, languagePack(language));
  await menu.register(explorerMenuLabels());
}

function main(): void {
  const argv = userArguments(process.argv, app.isPackaged);
  const args = parseCliArgs(argv);
  const dataRoot = args.userDataDir ?? path.join(app.getPath('appData'), 'Vilausity');
  const paths = createAppPaths(dataRoot, new Date(), isElevated());
  if (args.help || args.version) {
    process.stdout.write(args.help ? HELP_TEXT : versionText(args, paths));
    app.exit(0);
    return;
  }
  // File Explorer's "(Administrator)" entry: Windows asks, the administrator instance opens the
  // folder (or the running one takes it), and this start has nothing more to do.
  if (args.admin && !paths.elevated) {
    const appPath = app.isPackaged ? undefined : app.getAppPath();
    void startElevated(process.execPath, administratorInstanceArgs(args.folder ?? process.cwd(), appPath, args.userDataDir)).finally(() =>
      app.exit(0),
    );
    return;
  }
  if (args.registerContextMenu || args.unregisterContextMenu) {
    void changeExplorerMenu(args.registerContextMenu, paths.settingsFile).then(
      () => app.exit(0),
      (error: unknown) => {
        process.stderr.write(`${String(error)}\n`);
        app.exit(1);
      },
    );
    return;
  }

  // Must happen before the app is ready.
  registerCcwSchemePrivileges();
  // No application menu: it would bring Electron's default accelerators (Ctrl+W, Ctrl+R...).
  Menu.setApplicationMenu(null);
  // The installer's Start menu shortcut carries this id: windows started any other way (File
  // Explorer's menu, a link, a provider's shortcut) group with it and its pinned icon. Not in
  // development, where they would group with an installed copy.
  if (app.isPackaged) {
    app.setAppUserModelId(APP_ID);
  }

  // The administrator instance's own folder, so that it gets a lock of its own too.
  app.setPath('userData', paths.instanceRoot);
  app.setPath('sessionData', paths.chromium);

  // One instance per data folder (the lock lives in userData): a second start hands its
  // arguments to the running one and quits, before it writes anything. The administrator
  // instance has its own lock: it runs next to the normal one.
  const secondStart: SecondStart = { argv, cwd: process.cwd() };
  if (!app.requestSingleInstanceLock(secondStart)) {
    app.quit();
    return;
  }

  const logLevel = parseLogLevel(args.logLevel, LogLevel.Info);
  const sink = new FileLogSink(path.join(paths.sessionLogs, 'main.log'), !app.isPackaged);
  const logger = new Logger(sink, 'main', () => logLevel);
  setUnexpectedErrorHandler((error) => logger.error('unexpected error in listener', error));
  if (paths.elevated) {
    logger.info(`administrator instance: its own state and Chromium profile in ${paths.instanceRoot}`);
  }
  // Before Chromium reads Local State (which it does once the app gets going): one key for
  // the API keys of both instances.
  shareSafeStorageKey(paths.chromium, paths.otherChromium, paths.elevated, logger);
  process.on('uncaughtException', (error) => logger.error('uncaught exception', error));
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', reason));

  let shellApp: ShellApp | undefined;
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    shellApp?.flushSync();
    sink.flushSync();
  });
  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    if (!isSecondStart(additionalData)) {
      logger.warn('a second start sent no arguments');
      return;
    }
    const forwarded = parseCliArgs(additionalData.argv, additionalData.cwd);
    void started.then(() => shellApp?.handleCommandLine(forwarded));
  });

  void app
    .whenReady()
    .then(async () => {
      pruneOldLogs(paths);
      logger.info(`vilaus ${app.getVersion()} starting; data in ${dataRoot}`);
      shellApp = new ShellApp({ args, paths, appDir: __dirname, logger, logLevel });
      await shellApp.start();
      markStarted();
    })
    .catch((error: unknown) => {
      logger.error('fatal startup error', error);
      sink.flushSync();
      app.exit(1);
    });
}

main();
