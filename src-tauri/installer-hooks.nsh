; "Open in Verta" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

; The app's identity, as Windows wants it before it will show a notification at all.
;
; Measured on an installed build: the notification reached the shell and was written to the
; notification database under `app.verta`, and Windows displayed nothing - because that
; identity was not registered with the shell. The Start Menu shortcut carries it too, but a
; shortcut alone is not enough once the app runs unpackaged; the registration below is what
; the shell looks the name and icon up in.
!macro Verta_RegisterAppUserModelId
  WriteRegStr HKCU "Software\Classes\AppUserModelId\app.verta" "DisplayName" "Verta"
  WriteRegStr HKCU "Software\Classes\AppUserModelId\app.verta" "IconUri" "$INSTDIR\verta.exe"
!macroend

!macro Verta_UnregisterAppUserModelId
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\app.verta"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro Verta_RegisterAppUserModelId

  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInVerta" "" "Open in Verta"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInVerta" "Icon" '"$INSTDIR\verta.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInVerta" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInVerta\command" "" '"$INSTDIR\verta.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInVerta" "" "Open in Verta"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInVerta" "Icon" '"$INSTDIR\verta.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInVerta" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInVerta\command" "" '"$INSTDIR\verta.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInVerta" "" "Open in Verta"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInVerta" "Icon" '"$INSTDIR\verta.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInVerta" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInVerta\command" "" '"$INSTDIR\verta.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro Verta_UnregisterAppUserModelId

  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInVerta"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInVerta"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInVerta"
!macroend
