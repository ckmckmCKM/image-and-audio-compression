!include LogicLib.nsh
!include FileFunc.nsh

Unicode true
Name "图片与音频压缩"
OutFile "${OUTPUT_FILE}"
Icon "${APP_ICON}"
RequestExecutionLevel user
CRCCheck off
SetCompressor /FINAL zlib
SetDatablockOptimize on
FileBufSize 64
AutoCloseWindow true
ShowInstDetails nevershow
BrandingText "图片与音频压缩"
Caption "图片与音频压缩 — 正在准备首次启动"
SubCaption 3 " "
CompletedText "准备完成"
VIProductVersion "${WINDOWS_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "图片与音频压缩"
VIAddVersionKey /LANG=1033 "FileDescription" "图片与音频压缩免安装版"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Media Compressor Contributors"
Page instfiles

Var cacheDir
Var cacheReady
Var cacheMutex
Var preparationStep
Var markerValid

Function ReportStartupError
  System::Call 'kernel32::GetLastError() i.r2'
  ReadEnvStr $R0 MEDIA_COMPRESSOR_SMOKE_DIR
  ${If} $R0 != ""
    CreateDirectory "$R0"
    FileOpen $0 "$R0\portable-error.txt" w
    FileWrite $0 "$preparationStep (Windows error $2); cache: $cacheDir"
    FileClose $0
  ${Else}
    MessageBox MB_OK|MB_ICONSTOP "无法准备启动组件。请检查磁盘空间，关闭正在使用该版本的窗口后重试。"
  ${EndIf}
  Call ReleaseCacheMutex
  SetErrorLevel 1
  Quit
FunctionEnd

Function ReleaseCacheMutex
  ${If} $cacheMutex != 0
    System::Call 'kernel32::ReleaseMutex(p $cacheMutex)'
    System::Call 'kernel32::CloseHandle(p $cacheMutex)'
    StrCpy $cacheMutex 0
  ${EndIf}
FunctionEnd

Function ValidateCache
  StrCpy $cacheReady 0
  StrCpy $markerValid 0
  IfFileExists "$cacheDir\.portable-ready" 0 cache_invalid
  ClearErrors
  FileOpen $0 "$cacheDir\.portable-ready" r
  IfErrors cache_invalid
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "${CACHE_ID}" 0 cache_invalid
  StrCpy $markerValid 1
  # Generated from the packaged file inventory; missing components trigger repair.
  !include "${CACHE_CHECKS}"
  IfFileExists "$cacheDir\.portable-ready" 0 cache_invalid
  StrCpy $cacheReady 1
  cache_invalid:
FunctionEnd

Function AcquireCacheMutex
  StrCpy $preparationStep "lock component cache"
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\MediaCompressor.portable.${CACHE_ID}") p.r0'
  StrCpy $cacheMutex $0
  ${If} $cacheMutex == 0
    Call ReportStartupError
  ${EndIf}
  # Serialize preparation. A missing marker makes an interrupted extraction restart.
  System::Call 'kernel32::WaitForSingleObject(p $cacheMutex, i -1) i.r0'
  ${If} $0 != 0
  ${AndIf} $0 != 128
    Call ReportStartupError
  ${EndIf}
FunctionEnd

Function .onInit
  StrCpy $cacheMutex 0
  StrCpy $cacheDir "$LOCALAPPDATA\MediaCompressor\portable\${CACHE_ID}"
  Call ValidateCache
  ${If} $cacheReady == 1
    SetSilent silent
  ${EndIf}
FunctionEnd

Function .onGUIEnd
  Call ReleaseCacheMutex
FunctionEnd

Section
  ${If} $cacheReady != 1
    # NSIS executes sections on a worker thread; acquire and release on that
    # same thread so another first launch can proceed as soon as files are ready.
    Call AcquireCacheMutex
    Call ValidateCache
  ${EndIf}
  ${If} $cacheReady != 1
    # A valid marker with missing files only needs those files restored. Existing
    # components may already be loaded by another window and must remain untouched.
    ${If} $markerValid == 1
      SetOverwrite off
    ${Else}
      SetOverwrite on
    ${EndIf}
    Delete "$cacheDir\.portable-ready"
    ClearErrors
    StrCpy $preparationStep "extract files"
    SetOutPath "$cacheDir"
    File /r "${APP_DIR}\*"
    IfErrors extraction_failed
    StrCpy $preparationStep "write completion marker"
    FileOpen $0 "$cacheDir\.portable-ready" w
    IfErrors extraction_failed
    FileWrite $0 "${CACHE_ID}"
    FileClose $0
    IfErrors extraction_failed
    Call ValidateCache
    StrCpy $preparationStep "validate components"
    ${If} $cacheReady != 1
      Goto extraction_failed
    ${EndIf}
  ${EndIf}
  Call ReleaseCacheMutex

  System::Call 'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_DIR", w "$EXEDIR")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_FILE", w "$EXEPATH")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_APP_FILENAME", w "MediaCompressor")'
  ${GetParameters} $R0
  HideWindow
  ExecWait '"$cacheDir\MediaCompressor.exe" $R0' $0
  IfErrors launch_failed
  SetErrorLevel $0
  Quit

  extraction_failed:
    Call ReportStartupError
  launch_failed:
    MessageBox MB_OK|MB_ICONSTOP "无法打开程序，请重新启动；如仍无法打开，可清理组件缓存后重试。"
    SetErrorLevel 1
SectionEnd
