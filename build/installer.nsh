; ---- Setup WINDOW art ----------------------------------------------------
; The running installer window shows the TRANSPARENT claw art - the small
; titlebar icon, the taskbar entry, and any header repeat that draws the
; window icon - while Setup.exe's FILE icon stays the filled plaque
; compiled in as MUI_ICON, so the installer file keeps matching the
; installed app in Explorer. WM_SETICON swaps only the runtime window
; icons at GUI init; the FILE icon resource is untouched.
!ifndef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_GUIINIT claudeampWindowArt
  Function claudeampWindowArt
    InitPluginsDir
    File "/oname=$PLUGINSDIR\claw-mark.ico" "${PROJECT_DIR}\assets\claw-mark.ico"
    ; IMAGE_ICON=1, LR_LOADFROMFILE=0x10; 0x0080 is WM_SETICON
    System::Call 'user32::LoadImage(p 0, t "$PLUGINSDIR\claw-mark.ico", i 1, i 16, i 16, i 0x10) p .r0'
    System::Call 'user32::LoadImage(p 0, t "$PLUGINSDIR\claw-mark.ico", i 1, i 32, i 32, i 0x10) p .r1'
    StrCmp $0 0 +2
      SendMessage $HWNDPARENT 0x0080 0 $0
    StrCmp $1 0 +2
      SendMessage $HWNDPARENT 0x0080 1 $1
  FunctionEnd
!endif

!macro refreshClaudeAmpShortcut LINK
  ${If} ${FileExists} "${LINK}"
    CreateShortCut "${LINK}" "$appExe" "" "$INSTDIR\resources\claw-icon.ico" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "${LINK}" "${APP_ID}"
  ${EndIf}
!macroend

!macro customInstall
  ; Give every installer-created shortcut a stable icon file outside app.asar.
  ; Also rewrite an existing taskbar pin during upgrades: Windows otherwise
  ; keeps the blank icon it cached when an older build first created the pin.
  !insertmacro refreshClaudeAmpShortcut "$newStartMenuLink"
  !insertmacro refreshClaudeAmpShortcut "$newDesktopLink"
  !insertmacro refreshClaudeAmpShortcut "$QUICKLAUNCH\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk"

  ; Notify Explorer that shortcut/icon metadata changed, then ask the per-user
  ; icon cache to repaint without restarting Explorer or clearing other pins.
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  IfFileExists "$SYSDIR\ie4uinit.exe" 0 +2
    ExecWait '"$SYSDIR\ie4uinit.exe" -show'
!macroend
