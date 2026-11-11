; Instalação por máquina com o serviço do Windows (DommaViewService).
; Código da empresa: do nome do instalador (DommaView-Setup_ML-4821-ECV.exe)
; ou do parâmetro /EMPRESA=ML-4821-ECV (instalação em massa, ex.: GPO com /S).
!include "FileFunc.nsh"

!macro customInit
  ; atualização: para o serviço antes de copiar os arquivos (o .exe fica em uso)
  nsExec::Exec 'sc.exe stop DommaViewService'
  Sleep 2000
  nsExec::Exec 'taskkill.exe /F /IM DommaViewService.exe'
!macroend

!macro customInstall
  Var /GLOBAL DvCode
  StrCpy $DvCode ""
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/EMPRESA=" $DvCode
  ${If} $DvCode == ""
    StrCpy $DvCode $EXEFILE
  ${EndIf}
  FileOpen $R1 "$INSTDIR\setup-code.txt" w
  FileWrite $R1 $DvCode
  FileClose $R1
  DetailPrint "Instalando o serviço do Domma View"
  nsExec::ExecToLog '"$INSTDIR\resources\DommaViewService.exe" install --config "$INSTDIR\resources\config.json" --empresa "$DvCode"'
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$INSTDIR\resources\DommaViewService.exe" uninstall'
!macroend
