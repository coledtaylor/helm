; Included by electron-builder's NSIS script (`nsis.include` in
; electron-builder.yml), ahead of its own includes, in both the installer and
; the uninstaller.
;
; Before an install replaces anything, this PC's local host has to go: a
; running floti.exe cannot be replaced, and electron-builder's own check would
; force-stop it with every process under the install folder, ending the
; sessions it runs without a word. So, when a Helm with a floti.exe is already
; installed, the installer asks how many sessions the host runs
; (`floti update-stop <client folder> --ask`), with Helm's client folder:
;
; - one or more: it prints the question, which says how many end and that
;   Helm offers them back; OK stops the host for an update (`--stop`, which
;   returns once it has exited) and goes on, and Cancel quits the installer
;   with every session still running;
; - none (status 7): the host is stopped the same way, with no question;
; - anything else - no host answering, a client folder Helm never paired, a
;   host it cannot talk to - asks nothing and leaves the host to the check
;   below, as before.
;
; The floti.exe that asks is the one this installer carries, not the one
; installed: an installed Helm from before `update-stop` existed has a
; floti.exe that does not know the subcommand, and the question has to come
; from the first update over it too. The installer carries the copy
; electron-builder packs at `resources\floti.exe` (`dist-host\floti.exe`, an
; extraResource) and writes it to its own temporary folder ($PLUGINSDIR),
; which it removes when it ends.
;
; Then electron-builder's own check runs, which asks the user to close Helm if
; it is still running. A silent install (/S) answers OK, as that check does.
;
; Defining customCheckAppRunning replaces the default check, and drops the
; include and variable allowOnlyOneInstallerInstance.nsh brings for it; the
; default check is still the one that runs, so both are brought here.
;
; The client folder is `host-client` in Helm's data directory, which for the
; installed app is %APPDATA%\<productName> (`clientFolder` in
; src/main/host/launcher.ts, `appMode` in src/main/paths.ts). It and the
; floti.exe carried are defines, which a script including this one may set
; first to point them elsewhere.

!include "LogicLib.nsh"
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !insertmacro HELM_STOP_LOCAL_HOST
  !endif
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

!ifndef HELM_UPDATE_STOP_FLOTI
  !define HELM_UPDATE_STOP_FLOTI "${PROJECT_DIR}\dist-host\floti.exe"
!endif
!ifndef HELM_CLIENT_FOLDER
  !define HELM_CLIENT_FOLDER "$APPDATA\${PRODUCT_NAME}\host-client"
!endif

!macro HELM_STOP_LOCAL_HOST
  ${If} ${FileExists} "$INSTDIR\resources\floti.exe"
    InitPluginsDir
    File "/oname=$PLUGINSDIR\floti-update-stop.exe" "${HELM_UPDATE_STOP_FLOTI}"
    nsExec::ExecToStack `"$PLUGINSDIR\floti-update-stop.exe" update-stop "${HELM_CLIENT_FOLDER}" --ask`
    Pop $0 ; the exit status, or "error" when it could not run
    Pop $1 ; the question, when there is one
    StrCpy $2 ""
    ${If} $0 == 7
      StrCpy $2 "stop"
    ${ElseIf} $0 == 0
      ${If} ${Cmd} `MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$1" /SD IDOK IDCANCEL`
        Quit
      ${EndIf}
      StrCpy $2 "stop"
    ${EndIf}
    ${If} $2 == "stop"
      DetailPrint "Stopping the local host on this PC."
      nsExec::Exec `"$PLUGINSDIR\floti-update-stop.exe" update-stop "${HELM_CLIENT_FOLDER}" --stop`
      Pop $0
    ${EndIf}
    Delete "$PLUGINSDIR\floti-update-stop.exe"
  ${EndIf}
!macroend
