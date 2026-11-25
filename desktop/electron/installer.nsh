; Windows installer additions for the Electron build (electron-builder NSIS).
;
; Up to 0.9.5 Docuflex for Windows was a Tauri app installed per user in
; %LOCALAPPDATA%\Docuflex as docuflex-desktop.exe. The Electron build installs
; to the same folder under the same executable name, so the old in-app updater
; (which runs this installer with /S and then starts that path) opens the new
; version. The Tauri copy is removed first so there is one Start menu entry,
; one uninstaller and one .pdf handler. User data is kept: it lives in
; %USERPROFILE%\.docuflex and %LOCALAPPDATA%\com.docuflex.editor.

!macro preInit
  SetRegView 64
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Docuflex"
  SetRegView 32
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Docuflex"
!macroend

; PDF registration, per user. Windows 11 lists an app under "Open with" and in
; Settings > Default apps only when it has a named ProgId in
; .pdf\OpenWithProgids, an Applications\<exe> entry and registered
; Capabilities. This never takes over the user's current default PDF app.
!define DOCUFLEX_PROGID "Docuflex.PDF"
!define DOCUFLEX_CAPABILITIES "Software\Docuflex\Capabilities"

!macro customInstall
  StrCpy $0 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  StrCpy $1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'

  ; Test builds of this installer wrote a generic "PDF Document" ProgId.
  ReadRegStr $2 HKCU "Software\Classes\PDF Document\shell\open\command" ""
  ${If} $2 == '$INSTDIR\${APP_EXECUTABLE_FILENAME} "%1"'
    DeleteRegKey HKCU "Software\Classes\PDF Document"
    DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "PDF Document"
    ReadRegStr $2 HKCU "Software\Classes\.pdf" ""
    ${If} $2 == "PDF Document"
      DeleteRegValue HKCU "Software\Classes\.pdf" ""
    ${EndIf}
  ${EndIf}

  WriteRegStr HKCU "Software\Classes\${DOCUFLEX_PROGID}" "" "PDF Document"
  WriteRegStr HKCU "Software\Classes\${DOCUFLEX_PROGID}" "FriendlyTypeName" "PDF Document"
  WriteRegStr HKCU "Software\Classes\${DOCUFLEX_PROGID}\Application" "ApplicationName" "Docuflex"
  WriteRegStr HKCU "Software\Classes\${DOCUFLEX_PROGID}\Application" "ApplicationIcon" $1
  WriteRegStr HKCU "Software\Classes\${DOCUFLEX_PROGID}\Application" "AppUserModelID" "com.docuflex.editor"
  WriteRegStr HKCU "Software\Classes\${DOCUFLEX_PROGID}\DefaultIcon" "" $1
  WriteRegStr HKCU "Software\Classes\${DOCUFLEX_PROGID}\shell\open" "FriendlyAppName" "Docuflex"
  WriteRegStr HKCU "Software\Classes\${DOCUFLEX_PROGID}\shell\open\command" "" $0
  WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "${DOCUFLEX_PROGID}" ""

  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Docuflex"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\DefaultIcon" "" $1
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".pdf" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open" "FriendlyAppName" "Docuflex"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" $0

  WriteRegStr HKCU "${DOCUFLEX_CAPABILITIES}" "ApplicationName" "Docuflex"
  WriteRegStr HKCU "${DOCUFLEX_CAPABILITIES}" "ApplicationDescription" "Offline PDF editor"
  WriteRegStr HKCU "${DOCUFLEX_CAPABILITIES}" "ApplicationIcon" $1
  WriteRegStr HKCU "${DOCUFLEX_CAPABILITIES}\FileAssociations" ".pdf" "${DOCUFLEX_PROGID}"
  WriteRegStr HKCU "Software\RegisteredApplications" "Docuflex" "${DOCUFLEX_CAPABILITIES}"

  ; SHCNE_ASSOCCHANGED: Explorer re-reads the associations immediately.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\${DOCUFLEX_PROGID}"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "${DOCUFLEX_PROGID}"
  DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey HKCU "Software\Docuflex"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Docuflex"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customInit
  ClearErrors
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Docuflex" "UninstallString"
  ${IfNot} ${Errors}
  ${AndIf} ${FileExists} "$LOCALAPPDATA\Docuflex\uninstall.exe"
    ; Close a running Tauri copy, then uninstall it in place and wait (_?=).
    nsExec::Exec 'taskkill.exe /IM docuflex-desktop.exe /T /F'
    Pop $1
    ExecWait '"$LOCALAPPDATA\Docuflex\uninstall.exe" /S _?=$LOCALAPPDATA\Docuflex' $1
    Delete "$LOCALAPPDATA\Docuflex\uninstall.exe"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Docuflex"
  ${EndIf}
!macroend
