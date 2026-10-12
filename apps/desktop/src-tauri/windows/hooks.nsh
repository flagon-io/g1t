; Hooks into the Windows installer Tauri makes (tauri.conf.json,
; bundle.windows.nsis.installerHooks).
;
; Uninstalling with "Delete the application data" ticked takes the runner's
; sandbox with it: its WSL distribution (g1t-sandbox) is registered with
; Windows apart from the app's folder, so deleting the folder alone left it
; behind, and g1t installed again found a sandbox it had no record of. Not
; on an update (/UPDATE), which uninstalls the old version to install the
; new one and keeps everything. The runner's folder is in local data, or in
; roaming data where an older version set it up; either is seen to.

!macro G1T_REMOVE_SANDBOX ROOT
  ${If} ${FileExists} "${ROOT}\sh.g1t.desktop\runner\bin\g1t-runner.exe"
    nsExec::Exec '"${ROOT}\sh.g1t.desktop\runner\bin\g1t-runner.exe" sandbox down --delete --state-dir "${ROOT}\sh.g1t.desktop\runner\sandbox"'
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    !insertmacro G1T_REMOVE_SANDBOX "$LOCALAPPDATA"
    !insertmacro G1T_REMOVE_SANDBOX "$APPDATA"
  ${EndIf}
!macroend
