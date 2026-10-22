/**
 * Ids of the core services every shell module can use. A module that offers a service to
 * other modules declares its id next to its implementation (in its own feature folder).
 */

import type { CommandService } from './commands';
import type { ContextKeyService } from './contextKeys';
import type { Dialogs } from './dialogs';
import type { EditorRegistry } from './editors';
import type { ExtensionHostConnection } from './extensionHost';
import type { KeybindingService } from './keybindings';
import type { Layout } from './layout';
import type { LocalApiService } from './localApi';
import type { MenuService } from './menus';
import type { NativeApi } from './native';
import type { PanelRouter } from './panels';
import type { QuickAccess } from './quickAccess';
import { createServiceId } from './services';
import type { SettingsService } from './settings';
import type { ThemeService } from './themes';
import type { WebviewFrames } from './webviewFrames';

export interface WorkspaceInfo {
  readonly folders: readonly string[];
  /** Display name: the first folder's base name. */
  readonly name: string;
  /** The user's home folder: as a workspace, it stands for the whole computer. */
  readonly homeFolder: string;
  /** The administrator instance (elevated). */
  readonly elevated: boolean;
}

export const ICommands = createServiceId<CommandService>('commands');
export const IKeybindings = createServiceId<KeybindingService>('keybindings');
export const IContextKeys = createServiceId<ContextKeyService>('contextKeys');
export const IMenus = createServiceId<MenuService>('menus');
export const ILayout = createServiceId<Layout>('layout');
export const IWebviewFrames = createServiceId<WebviewFrames>('webviewFrames');
export const IDialogs = createServiceId<Dialogs>('dialogs');
export const IExtensionHost = createServiceId<ExtensionHostConnection>('extensionHost');
export const INative = createServiceId<NativeApi>('native');
export const IThemes = createServiceId<ThemeService>('themes');
export const IWorkspace = createServiceId<WorkspaceInfo>('workspace');
export const IEditors = createServiceId<EditorRegistry>('editors');
export const IPanels = createServiceId<PanelRouter>('panels');
export const ISettings = createServiceId<SettingsService>('settings');
export const IQuickAccess = createServiceId<QuickAccess>('quickAccess');
/** Operations and events for programs on this computer (the local API). */
export const ILocalApi = createServiceId<LocalApiService>('localApi');
