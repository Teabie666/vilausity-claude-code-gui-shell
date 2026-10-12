/**
 * The product's identity outside the app, shared by the code and the installer:
 * electron-builder.config.mjs imports this file (Node strips its types), so it must not import
 * anything and must stay plain TypeScript (no enums, no namespaces).
 */

/**
 * The installer's appId and Windows' AppUserModelID of the Start menu shortcut and the windows
 * (the taskbar groups them by it, toasts are attributed to it). Never change it: the
 * installer derives the installation's registry key from it, so a new id would install a
 * second copy next to the first.
 */
export const APP_ID = 'io.github.teabie666.vilausity';

/** The scheme of the links handed to the extension's `window.registerUriHandler` (`vilaus://...`). */
export const URI_SCHEME = 'vilaus';
