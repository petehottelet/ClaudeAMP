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
