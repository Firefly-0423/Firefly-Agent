; Firefly 的 NSIS 定制：安装选项页、桌面快捷方式、开机自启，以及升级时保住用户放进安装目录的内容。
!include "nsDialogs.nsh"

; ---------------------------------------------------------------------------
; 升级保护（安装器和卸载器共用）
;
; 升级时旧版卸载器会 RMDir /r 整个安装目录，models/skills/prompts 里用户自己的文件会一起消失。
; 先把它们挪到安装目录旁边的暂存位置：
;   prompts、skills → .Firefly.content-preserve\（应用下次启动时合并进用户数据）
;   models          → .Firefly.models-preserve（新版装完后原样搬回）
; ---------------------------------------------------------------------------
!define FIREFLY_CONTENT_STASH "$INSTDIR\..\.Firefly.content-preserve"
!define FIREFLY_MODELS_STASH "$INSTDIR\..\.Firefly.models-preserve"

!macro FireflyStashFolder FOLDER TARGET
  ClearErrors
  ${If} ${FileExists} "$INSTDIR\${FOLDER}"
    Rename "$INSTDIR\${FOLDER}" "${TARGET}"
  ${EndIf}
!macroend

!macro FireflyStashUserContent
  CreateDirectory "${FIREFLY_CONTENT_STASH}"
  !insertmacro FireflyStashFolder "prompts" "${FIREFLY_CONTENT_STASH}\prompts"
  !insertmacro FireflyStashFolder "skills" "${FIREFLY_CONTENT_STASH}\skills"
  !insertmacro FireflyStashFolder "models" "${FIREFLY_MODELS_STASH}"
!macroend

!macro FireflyRestoreModels
  ${If} ${FileExists} "${FIREFLY_MODELS_STASH}"
    CreateDirectory "$INSTDIR"
    Rename "${FIREFLY_MODELS_STASH}" "$INSTDIR\models"
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
; ---------------------------------------------------------------------------
; 安装器
; ---------------------------------------------------------------------------
Var FireflyShortcutBox
Var FireflyAutostartBox
Var FireflyWantsShortcut
Var FireflyWantsAutostart
Var FireflyAutostartJson

!macro customPageAfterChangeDir
  Page custom FireflyOptionsShow FireflyOptionsRead
!macroend

; 在选项页的第 TOP 行放一个复选框，句柄存进 HANDLE，初始状态由 MARK（Check / Uncheck）决定。
!macro FireflyOptionBox TOP LABEL HANDLE MARK
  ${NSD_CreateCheckbox} 0 ${TOP} 100% 12u "${LABEL}"
  Pop ${HANDLE}
  ${NSD_${MARK}} ${HANDLE}
!macroend

; 选项页：桌面快捷方式默认勾选，开机自启默认不勾。
Function FireflyOptionsShow
  nsDialogs::Create 1018
  Pop $0
  StrCmp $0 "error" 0 +2
    Abort
  ${NSD_CreateLabel} 0 0 100% 24u "安装选项"
  Pop $0
  !insertmacro FireflyOptionBox 34u "创建桌面快捷方式" $FireflyShortcutBox Check
  !insertmacro FireflyOptionBox 56u "开机时自动启动 Firefly" $FireflyAutostartBox Uncheck
  nsDialogs::Show
FunctionEnd

Function FireflyOptionsRead
  ${NSD_GetState} $FireflyShortcutBox $FireflyWantsShortcut
  ${NSD_GetState} $FireflyAutostartBox $FireflyWantsAutostart
FunctionEnd

; .onInit 时 multiUser 已把 $INSTDIR 恢复成旧安装目录。只在静默安装（应用内更新、独立升级器）时暂存：
; 向导安装有人在场，中途取消不应留下被挪走的目录。
!macro customInit
  ${If} ${Silent}
    !insertmacro FireflyStashUserContent
  ${EndIf}
!macroend

!macro customInstall
  ; 新版安装器不写 models，把暂存的原样搬回即可。
  ClearErrors
  !insertmacro FireflyRestoreModels

  ${If} $FireflyWantsShortcut == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${EndIf}

  CreateShortCut "$SMPROGRAMS\${MENU_FILENAME}\卸载 ${PRODUCT_FILENAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}" "" "$INSTDIR\${UNINSTALL_FILENAME}" 0

  ; 把“开机自启”的选择交给应用：首次启动时由设置读取 installer-options.json。
  StrCpy $FireflyAutostartJson "false"
  ${If} $FireflyWantsAutostart == ${BST_CHECKED}
    StrCpy $FireflyAutostartJson "true"
  ${EndIf}
  CreateDirectory "$APPDATA\Firefly"
  FileOpen $0 "$APPDATA\Firefly\installer-options.json" w
  FileWrite $0 "{$\"launchAtLogin$\":$FireflyAutostartJson}"
  FileClose $0
!macroend
!endif

; ---------------------------------------------------------------------------
; 卸载器
; ---------------------------------------------------------------------------
!macro customUnInstall
  Delete "$SMPROGRAMS\${MENU_FILENAME}\卸载 ${PRODUCT_FILENAME}.lnk"
!macroend

; 新版安装器以 --updated 调起旧卸载器时，先暂存用户内容再清目录，清完把 models 搬回；
; prompts、skills 留在暂存目录等应用合并。用户主动卸载（没有 --updated）时整个目录照常删除。
!macro customRemoveFiles
  SetOutPath "$TEMP"
  ${If} ${isUpdated}
    !insertmacro FireflyStashUserContent
    RMDir /r "$INSTDIR"
    !insertmacro FireflyRestoreModels
  ${Else}
    RMDir /r "$INSTDIR"
  ${EndIf}
!macroend
