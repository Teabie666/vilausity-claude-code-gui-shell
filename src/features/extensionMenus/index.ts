/**
 * The extension's context menus. Registers the `webview/context` items the extension
 * declares in its package.json, and keeps main told which items each webview's right-click
 * menu gets: main builds the native menu, and a click comes back as `contextMenuAction`.
 */

import { MenuId } from '../../core/menus';
import type { ShellModule } from '../../core/module';
import { ICommands, IContextKeys, IExtensionHost, IMenus, INative, IWebviewFrames } from '../../core/serviceIds';
import { DisposableStore } from '../../platform/lifecycle';
import type { ContextMenuItemDto } from '../../platform/protocol';
import { contributedMenuItems } from './menuItems';

export const extensionMenusModule: ShellModule = {
  id: 'extensionMenus',
  activate({ services, subscriptions, logger }) {
    const menus = services.get(IMenus);
    const frames = services.get(IWebviewFrames);
    const native = services.get(INative);
    const commands = services.get(ICommands);
    const contextKeys = services.get(IContextKeys);
    const connection = services.get(IExtensionHost);

    // Items from the current extension host; replaced when it restarts.
    const contributed = subscriptions.add(new DisposableStore());
    const itemsFor = (viewType: string) => menus.getGroups(MenuId.WebviewContext, { webviewId: viewType });

    // What main last got for each webview, so unchanged menus are not sent again.
    const sent = new Map<string, string>();
    const sync = (webviewId: string): void => {
      const viewType = frames.viewTypeOf(webviewId);
      const groups = (viewType === undefined ? [] : itemsFor(viewType)).map((group) =>
        group.map((item): ContextMenuItemDto => ({ id: item.command, label: item.title })),
      );
      const serialized = JSON.stringify(groups);
      if ((sent.get(webviewId) ?? '[]') === serialized) {
        return;
      }
      if (groups.length === 0) {
        sent.delete(webviewId);
      } else {
        sent.set(webviewId, serialized);
      }
      native
        .call('window.setWebviewMenu', { webviewId, groups })
        .catch((error: unknown) => logger.error(`updating the menu of webview ${webviewId} failed`, error));
    };

    let scheduled = false;
    const syncAll = (): void => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      // Context keys change in bursts (several per tab switch); sync once afterwards.
      queueMicrotask(() => {
        scheduled = false;
        new Set([...frames.all.map((webview) => webview.webviewId), ...sent.keys()]).forEach(sync);
      });
    };
    subscriptions.add(frames.onDidCreate(syncAll));
    subscriptions.add(frames.onDidDispose(syncAll));
    subscriptions.add(contextKeys.onDidChange(syncAll));
    subscriptions.add(
      menus.onDidChange((menuId) => {
        if (menuId === MenuId.WebviewContext) {
          syncAll();
        }
      }),
    );

    subscriptions.add(
      connection.onDidConnect((rpc) => {
        contributed.clear();
        rpc.call('extension.contributions', undefined).then(
          (contributions) => {
            if (connection.rpc !== rpc) {
              return; // A newer extension host took over meanwhile.
            }
            for (const item of contributedMenuItems(contributions, MenuId.WebviewContext)) {
              contributed.add(menus.register(MenuId.WebviewContext, item));
            }
          },
          (error: unknown) => logger.error('reading the extension contributions failed', error),
        );
      }),
    );
    subscriptions.add(connection.onDidDisconnect(() => contributed.clear()));

    subscriptions.add(
      native.on('contextMenuAction', ({ webviewId, id }) => {
        const viewType = frames.viewTypeOf(webviewId);
        if (viewType === undefined) {
          return;
        }
        // Only what this webview's menu offers right now (the when clause is checked again).
        if (
          !itemsFor(viewType)
            .flat()
            .some((item) => item.command === id)
        ) {
          logger.warn(`ignoring context menu command ${id}: not in the menu of webview ${webviewId}`);
          return;
        }
        // VS Code passes the webview's context as the argument; data-vscode-context
        // attributes are not collected yet, so it only names the webview.
        const context = { webview: viewType };
        const run = commands.has(id) ? commands.execute(id, context) : connection.executeCommand(id, context);
        run.catch((error: unknown) => logger.error(`context menu command ${id} failed`, error));
      }),
    );
  },
};
