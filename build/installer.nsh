; Vilausity's additions to electron-builder's assisted installer (electron-builder.config.ts,
; nsis.include). makensis reads it as UTF-8. electron-builder includes it ahead of its own
; script, before MUI2 and the languages: the texts name their languages by id (1033 English,
; 2052 Simplified Chinese, the installer's two languages), and whatever needs MUI goes inside
; the macros, which expand later.
;
; - vilaus:// links start the program, which hands them to the extension (the scheme is
;   URI_SCHEME in src/platform/product.ts). For the user, or for all users when installed for
;   them; electron-builder's `protocols` option registers nothing on Windows.
; - A page after the folder page offers File Explorer's "Open with Vilausity" entries: off on a
;   first install, as they are on a reinstall. The program adds or removes them itself
;   (--register-context-menu, --unregister-context-menu) under HKCU, so the installer runs it as
;   the user who started it, also when it elevated itself to install for all users.
; - Uninstalling removes both (the menu entries when they start this copy), except when an
;   update uninstalls the old version first.

!include LogicLib.nsh
!include nsDialogs.nsh

LangString vilausMenuTitle 1033 "File Explorer"
LangString vilausMenuTitle 2052 "文件资源管理器"
LangString vilausMenuSubtitle 1033 "Choose whether File Explorer's context menu offers Vilausity."
LangString vilausMenuSubtitle 2052 "选择要不要在文件资源管理器的右键菜单里加上 Vilausity。"
LangString vilausMenuOption 1033 "Add $\"Open with Vilausity$\" to the context menu of folders and drives"
LangString vilausMenuOption 2052 "在文件夹和驱动器的右键菜单里加上“用 Vilausity 打开”"
LangString vilausMenuNote 1033 "Right-clicking a folder, the empty space in a folder or a drive then offers $\"Open with Vilausity$\" and $\"Open with Vilausity (Administrator)$\", which open it as the workspace. For your Windows user only; on Windows 11 the entries are under $\"Show more options$\". Vilausity's settings can change this later (File Explorer: Context Menu)."
LangString vilausMenuNote 2052 "勾选后，在文件资源管理器里右键文件夹、文件夹空白处或驱动器，会出现“用 Vilausity 打开”和“用 Vilausity 打开（管理员）”，把它当工作区打开。只对你这个 Windows 用户生效；Windows 11 上它们在“显示更多选项”里。以后可以在 Vilausity 的设置里改（文件资源管理器: 右键菜单）。"

; The entries' key, as src/host/main/explorerMenu.ts writes it (the folder's one stands for all).
!define VILAUS_MENU_KEY "Software\Classes\Directory\shell\Vilausity\command"
!define VILAUS_URI_KEY "Software\Classes\vilaus"

!ifndef BUILD_UNINSTALLER
  Var vilausMenuWanted ; ${BST_CHECKED} or ${BST_UNCHECKED}
  Var vilausMenuWasThere ; 1 when the entries were there before this install
  Var vilausMenuCheckbox

  !macro customInit
    ; A silent install keeps this too.
    Push $0
    ReadRegStr $0 HKCU "${VILAUS_MENU_KEY}" ""
    ${if} $0 != ""
      StrCpy $vilausMenuWasThere 1
      StrCpy $vilausMenuWanted ${BST_CHECKED}
    ${else}
      StrCpy $vilausMenuWasThere 0
      StrCpy $vilausMenuWanted ${BST_UNCHECKED}
    ${endif}
    Pop $0
  !macroend

  !macro customPageAfterChangeDir
    Page custom vilausMenuPageShow vilausMenuPageLeave

    Function vilausMenuPageShow
      !insertmacro MUI_HEADER_TEXT "$(vilausMenuTitle)" "$(vilausMenuSubtitle)"
      nsDialogs::Create 1018
      Pop $0
      ${if} $0 == error
        Abort
      ${endif}
      ${NSD_CreateCheckbox} 0 0 100% 12u "$(vilausMenuOption)"
      Pop $vilausMenuCheckbox
      ${NSD_SetState} $vilausMenuCheckbox $vilausMenuWanted
      ${NSD_CreateLabel} 12u 20u -12u 60u "$(vilausMenuNote)"
      Pop $0
      nsDialogs::Show
    FunctionEnd

    Function vilausMenuPageLeave
      ${NSD_GetState} $vilausMenuCheckbox $vilausMenuWanted
    FunctionEnd

    ; Runs in the installer the user started (UAC_AsUser_Call), with $R0 the switch.
    Function vilausMenuApply
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" $R0'
    FunctionEnd
  !macroend

  !macro customInstall
    WriteRegStr SHELL_CONTEXT "${VILAUS_URI_KEY}" "" "URL:Vilausity"
    WriteRegStr SHELL_CONTEXT "${VILAUS_URI_KEY}" "URL Protocol" ""
    WriteRegStr SHELL_CONTEXT "${VILAUS_URI_KEY}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
    ; After --, Chromium takes no switches and the program no options: a link that broke out of
    ; its quotes cannot smuggle any in (--gpu-launcher=...). Electron does not stop at a link.
    WriteRegStr SHELL_CONTEXT "${VILAUS_URI_KEY}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'

    ; Added, or rewritten for this folder; removed when unticked on a reinstall.
    ${if} $vilausMenuWanted == ${BST_CHECKED}
    ${orIf} $vilausMenuWasThere == 1
      Push $R0
      ${if} $vilausMenuWanted == ${BST_CHECKED}
        StrCpy $R0 "--register-context-menu"
      ${else}
        StrCpy $R0 "--unregister-context-menu"
      ${endif}
      !insertmacro UAC_AsUser_Call Function vilausMenuApply ${UAC_SYNCREGISTERS}|${UAC_SYNCINSTDIR}
      Pop $R0
    ${endif}
  !macroend
!endif

!ifdef BUILD_UNINSTALLER
  ; Expands after common.nsh, which defines APP_EXECUTABLE_FILENAME.
  !macro customHeader
    ; Runs in the uninstaller the user started (UAC_AsUser_Call): their HKCU has the entries.
    ; Only when they start this copy: they may be another installation's, or a development
    ; checkout's. The command starts with the program, quoted when its path has a space.
    Function un.vilausMenuRemove
      Push $R0
      Push $R1
      ReadRegStr $R0 HKCU "${VILAUS_MENU_KEY}" ""
      StrCpy $R1 $R0 1
      ${if} $R1 == '"'
        StrCpy $R0 $R0 "" 1
      ${endif}
      StrLen $R1 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      StrCpy $R0 $R0 $R1
      ${if} $R0 == "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --unregister-context-menu'
      ${endif}
      Pop $R1
      Pop $R0
    FunctionEnd
  !macroend

  !macro customUnInstall
    ; An update's uninstall of the old version: the new one writes them again.
    ${ifNot} ${isUpdated}
      DeleteRegKey SHELL_CONTEXT "${VILAUS_URI_KEY}"
      !insertmacro UAC_AsUser_Call Function un.vilausMenuRemove ${UAC_SYNCREGISTERS}|${UAC_SYNCINSTDIR}
    ${endIf}
  !macroend
!endif
