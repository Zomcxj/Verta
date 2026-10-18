; "Open in Verta" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
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
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInVerta"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInVerta"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInVerta"
!macroend
