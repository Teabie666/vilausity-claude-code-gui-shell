/**
 * Renderer entry point: lists the shell modules and starts the workbench.
 * To add a feature, write a module under src/features/ and add it here.
 */

import { createRendererLogger } from '../../core/log';
import { t } from '../../core/messages';
import type { ShellModule } from '../../core/module';
import { startWorkbench } from '../../core/workbench';
import { commandPaletteModule } from '../../features/commandPalette';
import { commentsModule } from '../../features/comments';
import { contentPaneModule } from '../../features/contentPane';
import { conversationsModule } from '../../features/conversations';
import { editorModule } from '../../features/editor';
import { fontsModule } from '../../features/fonts';
import { markdownModule } from '../../features/markdown';
import { providersModule } from '../../features/providers';
import { quickOpenModule } from '../../features/quickOpen';
import { extensionHostStatusModule } from '../../features/extensionHostStatus';
import { extensionMenusModule } from '../../features/extensionMenus';
import { extensionUpdatesModule } from '../../features/extensionUpdates';
import { languageModule } from '../../features/language';
import { sessionSearchModule } from '../../features/sessionSearch';
import { sessionsModule } from '../../features/sessions';
import { settingsModule } from '../../features/settings';
import { setupModule } from '../../features/setup';
import { themesModule } from '../../features/themes';
import { windowModule } from '../../features/window';
import { workspaceModule } from '../../features/workspace';

const modules: ShellModule[] = [
  windowModule,
  conversationsModule,
  contentPaneModule,
  editorModule,
  markdownModule,
  commentsModule,
  quickOpenModule,
  settingsModule,
  sessionsModule,
  sessionSearchModule,
  themesModule,
  fontsModule,
  languageModule,
  commandPaletteModule,
  extensionMenusModule,
  extensionHostStatusModule,
  workspaceModule,
  providersModule,
  extensionUpdatesModule,
  setupModule,
];

startWorkbench(modules).catch((error: unknown) => {
  createRendererLogger('renderer').error('workbench failed to start', error);
  document.body.textContent = t('startupFailed', String(error));
});
