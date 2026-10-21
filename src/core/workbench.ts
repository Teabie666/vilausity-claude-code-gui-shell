/**
 * Renderer composition root: creates the core services, activates the shell modules,
 * then connects to the extension host. Features never construct core services
 * themselves; they get them from the ServiceRegistry.
 */

import { setUnexpectedErrorHandler } from '../platform/event';
import { languagePack } from '../nls/packs';
import { htmlLang, setUiLanguage } from '../platform/nls';
import type { ThemeData } from '../platform/protocol';
import { CommandService } from './commands';
import { ContextKeyService } from './contextKeys';
import { Dialogs } from './dialogs';
import { EditorRegistry } from './editors';
import { ExtensionHostConnection } from './extensionHost';
import { KeybindingService } from './keybindings';
import { Layout } from './layout';
import { createRendererLogger } from './log';
import { MenuService } from './menus';
import { t } from './messages';
import { ModuleHost, type ShellModule } from './module';
import { native } from './native';
import { PanelRouter } from './panels';
import { QuickAccess } from './quickAccess';
import {
  ICommands,
  IContextKeys,
  IDialogs,
  IEditors,
  IExtensionHost,
  IKeybindings,
  ILayout,
  IMenus,
  INative,
  IPanels,
  IQuickAccess,
  ISettings,
  IThemes,
  IWebviewFrames,
  IWorkspace,
} from './serviceIds';
import { ServiceRegistry } from './services';
import { SettingsService } from './settings';
import { ThemeService } from './themes';
import { WebviewFrames } from './webviewFrames';

export async function startWorkbench(modules: readonly ShellModule[]): Promise<void> {
  const logger = createRendererLogger('workbench');
  setUnexpectedErrorHandler((error) => logger.error('unexpected error in listener', error));

  // Subscribe before any await: main posts the first port as soon as the page loads.
  const connection = new ExtensionHostConnection(logger.child('exthost'));
  native.onExtensionHostPort((port) => connection.connect(port));
  // So may a theme (main sends each change): the window takes the command line's provider
  // (--provider) once the page has loaded, and its accent may come after the init data.
  let newerTheme: ThemeData | undefined;
  const earlyThemes = native.on('themeChanged', (theme) => (newerTheme = theme));

  const init = await native.call('app.getInitData', undefined);
  const settings = new SettingsService(native);
  await settings.load();
  // Before any module runs: their strings are looked up in this language.
  setUiLanguage(init.language, languagePack(init.language));
  // Chromium picks fallback fonts by `lang`, e.g. a Chinese UI font for zh-CN.
  document.documentElement.lang = htmlLang(init.language);
  const services = new ServiceRegistry();
  const contextKeys = new ContextKeyService();
  const commands = new CommandService(contextKeys, logger.child('commands'));
  const keybindings = new KeybindingService(
    commands,
    contextKeys,
    (chords) => void native.call('window.setKeybindings', { chords }),
    logger.child('keybindings'),
  );
  native.on('keybinding', ({ chord }) => void keybindings.dispatch(chord));
  // The user's keybindings before any module registers the defaults they change.
  const userKeybindings = await native.call('keybindings.read', undefined);
  keybindings.setUserEntries(userKeybindings.entries);
  keybindings.filePath = userKeybindings.filePath;
  native.on('keybindingsChanged', ({ entries }) => keybindings.setUserEntries(entries));
  const menus = new MenuService(contextKeys, logger.child('menus'));

  const layout = new Layout();
  layout.tabs.setAttribute('aria-label', t('openConversations'));
  layout.sidebar.setAttribute('aria-label', t('sessions'));
  const frames = new WebviewFrames(connection, logger.child('webviews'));
  const themes = new ThemeService(newerTheme ?? init.theme, frames, native);
  earlyThemes.dispose();
  const dialogs = new Dialogs(layout.overlays, (width) => layout.quickInputLeft(width));
  const folder = init.workspaceFolders[0] ?? '';

  services.register(INative, native);
  services.register(IContextKeys, contextKeys);
  services.register(ICommands, commands);
  services.register(IKeybindings, keybindings);
  services.register(IMenus, menus);
  services.register(ILayout, layout);
  services.register(IWebviewFrames, frames);
  services.register(IThemes, themes);
  services.register(IDialogs, dialogs);
  services.register(IExtensionHost, connection);
  services.register(IWorkspace, {
    folders: init.workspaceFolders,
    name: folder.split(/[\\/]/).pop() || folder,
    homeFolder: init.homeFolder,
    elevated: init.elevated,
  });
  services.register(IEditors, new EditorRegistry());
  services.register(IPanels, new PanelRouter(connection, logger.child('panels')));
  services.register(ISettings, settings);
  services.register(IQuickAccess, new QuickAccess(dialogs, logger.child('quickAccess')));

  // Core RPC handlers: webview plumbing and the extension's message/picker UI.
  connection.onDidConnect((rpc) => {
    rpc.handle('webview.load', ({ webviewId, url }) => frames.load(webviewId, url));
    rpc.handle('webview.postMessage', ({ webviewId, message }) => frames.post(webviewId, message));
    rpc.handle('ui.showMessage', (request) => {
      // E.g. "Claude is requesting permission" arrives as info while you are in another app.
      if (!document.hasFocus()) {
        void native.call('os.notify', { title: 'Claude Code', body: request.message });
      }
      return dialogs.showMessage(request);
    });
    rpc.handle('ui.showQuickPick', (request) => dialogs.showQuickPick(request));
    rpc.handle('ui.showInputBox', (request) => dialogs.showInputBox(request));
    // As VS Code asks before an extension opens a link from outside (a web page can make one).
    rpc.handle(
      'ui.confirmOpenUri',
      async ({ uri, extensionName }) =>
        (await dialogs.showMessage({
          severity: 'info',
          modal: true,
          message: t('confirmOpenUri', extensionName),
          detail: uri,
          items: [t('open')],
        })) === 0,
    );
  });
  connection.onDidDisconnect(() => frames.disposeAll());
  native.on('extensionHostState', ({ state }) => {
    contextKeys.set('extensionHost.crashed', state === 'crashed');
    if (state === 'crashed') {
      connection.disconnect();
    }
  });

  const host = new ModuleHost(services, logger);
  await host.activateAll(modules);
  connection.start();
  logger.info(`workbench ready with ${modules.length} modules`);
}
