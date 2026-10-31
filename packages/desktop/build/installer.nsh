; Included by electron-builder's NSIS script (`nsis.include` in
; electron-builder.yml), ahead of its own includes, in both the installer and
; the uninstaller.
;
; Before an install replaces anything, this PC's local host has to go: a
; running floti.exe cannot be replaced, and electron-builder's own check would
; force-stop it with every process under the install folder, ending the
; sessions it runs without a word. So the installer first asks the floti.exe
; already installed, run with Helm's client folder, how many sessions the host
; runs (`floti update-stop <client folder> --ask`):
;
; - one or more: it prints the question, which says how many end and that
;   Helm offers them back; OK stops the host for an update (`--stop`, which
;   returns once it has exited) and goes on, and Cancel quits the installer
;   with every session still running;
; - none (status 7): the host is stopped the same way, with no question;
; - anything else - no floti.exe installed yet, one too old to know the
;   subcommand, no host answering, a client folder Helm never paired - asks
;   nothing and leaves the host to the check below, as before.
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
; src/main/host/launcher.ts, `appMode` in src/main/paths.ts).

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

!macro HELM_STOP_LOCAL_HOST
  ${If} ${FileExists} "$INSTDIR\resources\floti.exe"
    nsExec::ExecToStack `"$INSTDIR\resources\floti.exe" update-stop "$APPDATA\${PRODUCT_NAME}\host-client" --ask`
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
      nsExec::Exec `"$INSTDIR\resources\floti.exe" update-stop "$APPDATA\${PRODUCT_NAME}\host-client" --stop`
      Pop $0
    ${EndIf}
  ${EndIf}
!macroend
