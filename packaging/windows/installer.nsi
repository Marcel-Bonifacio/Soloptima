; Soloptima setup program: installs for the current user (no administrator rights) into %LOCALAPPDATA%\Programs\Soloptima,
; with a Start menu and a desktop shortcut and an uninstaller in Apps & features. Profiles and projects stay in
; %LOCALAPPDATA%\Soloptima, also when Soloptima is uninstalled. The app's updater starts it with /UPDATE: it then waits for
; Soloptima to close, installs over it without asking for a folder, and offers to start it again.
; Built by packaging/build-windows.sh: makensis -DVERSION=1.1.0 -DSRC=<program folder> -DOUT=<setup.exe> -DICON=<.ico>
Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\Soloptima"

Name "Soloptima"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\Soloptima"
InstallDirRegKey HKCU "${UNINST}" "InstallLocation"
BrandingText "Soloptima ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Soloptima"
VIAddVersionKey "CompanyName" "Marcel Wijata"
VIAddVersionKey "FileDescription" "Soloptima setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright 2026 Marcel Wijata"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Soloptima.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start Soloptima"

Var Update   ; 1 when the app's updater started this program

!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipWhenUpdating
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipWhenUpdating
!define MUI_LICENSEPAGE_TEXT_TOP "Soloptima is open source under the Apache License 2.0."
!define MUI_LICENSEPAGE_TEXT_BOTTOM "The licence needs no acceptance to install or use Soloptima. Click Next to continue."
!define MUI_LICENSEPAGE_BUTTON "$(^NextBtn)"
!insertmacro MUI_PAGE_LICENSE "${SRC}/LICENSE"
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipWhenUpdating
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  ${IfNot} ${Errors}
    StrCpy $Update 1
  ${EndIf}
FunctionEnd

Function SkipWhenUpdating
  ${If} $Update == 1
    Abort
  ${EndIf}
FunctionEnd

; Soloptima holds the mutex "Local\SoloptimaApp" while it runs (src/app_win.cpp): wait for it to close
!macro WAIT_FOR_APP UN
Function ${UN}WaitForApp
  StrCpy $2 0
  loop:
    System::Call 'kernel32::OpenMutexW(i 0x00100000, i 0, w "Local\SoloptimaApp") p .r1'
    StrCmp $1 0 done
    System::Call 'kernel32::CloseHandle(p r1)'
    IntOp $2 $2 + 1
    IntCmp $2 40 0 wait 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Soloptima is still running. Close it, then choose Retry." IDRETRY retry
    Abort
  retry:
    StrCpy $2 0
  wait:
    Sleep 500
    Goto loop
  done:
FunctionEnd
!macroend
!insertmacro WAIT_FOR_APP ""
!insertmacro WAIT_FOR_APP "un."

; The program file can stay locked for a moment after Soloptima has quit (closing, a virus scan): wait until it can be
; written, before anything is replaced
Function WaitForExe
  IfFileExists "$INSTDIR\Soloptima.exe" 0 done
  StrCpy $2 0
  loop:
    ClearErrors
    FileOpen $3 "$INSTDIR\Soloptima.exe" a
    IfErrors 0 free
    IntOp $2 $2 + 1
    IntCmp $2 50 0 wait 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Soloptima.exe is still in use. Close Soloptima, then choose Retry." IDRETRY retry
    Abort
  retry:
    StrCpy $2 0
  wait:
    Sleep 300
    Goto loop
  free:
    FileClose $3
  done:
FunctionEnd

Section "Soloptima"
  Call WaitForApp
  Call WaitForExe
  SetOutPath "$INSTDIR"
  File "${SRC}/Soloptima.exe"
  File "${SRC}/WebView2Loader.dll"
  Delete "$INSTDIR\LICENSE.md"   ; the licence file of versions before 1.1
  File "${SRC}/LICENSE"
  File "${SRC}/NOTICE"
  File "${SRC}/TERMS.md"
  File "${SRC}/THIRD_PARTY_NOTICES.md"
  File "${SRC}/README.txt"
  RMDir /r "$INSTDIR\web"   ; files an older version had
  File /r "${SRC}/web"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Soloptima.lnk" "$INSTDIR\Soloptima.exe"
  ${If} $Update != 1
    CreateShortcut "$DESKTOP\Soloptima.lnk" "$INSTDIR\Soloptima.exe"
  ${EndIf}
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegStr HKCU "${UNINST}" "DisplayName" "Soloptima"
  WriteRegStr HKCU "${UNINST}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST}" "Publisher" "Marcel Wijata"
  WriteRegStr HKCU "${UNINST}" "DisplayIcon" "$INSTDIR\Soloptima.exe"
  WriteRegStr HKCU "${UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr HKCU "${UNINST}" "URLInfoAbout" "https://github.com/Marcel-Bonifacio/Soloptima"
  WriteRegDWORD HKCU "${UNINST}" "EstimatedSize" $0
  WriteRegDWORD HKCU "${UNINST}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Call un.WaitForApp
  RMDir /r "$INSTDIR\web"
  Delete "$INSTDIR\Soloptima.exe"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\NOTICE"
  Delete "$INSTDIR\TERMS.md"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.md"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Soloptima.lnk"
  Delete "$DESKTOP\Soloptima.lnk"
  DeleteRegKey HKCU "${UNINST}"
SectionEnd
