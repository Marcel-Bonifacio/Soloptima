; Soloptima: files that the 1.x setup program installed and this one does not. Removed when a 1.x copy is updated in place.
!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\web"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\LICENSE.md"
!macroend
!macro NSIS_HOOK_POSTINSTALL
!macroend
!macro NSIS_HOOK_PREUNINSTALL
!macroend
!macro NSIS_HOOK_POSTUNINSTALL
!macroend
