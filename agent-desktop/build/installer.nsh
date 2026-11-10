; Lê o código da empresa do nome do instalador (DommaView-Setup_ML-4821-ECV.exe)
; ou do parâmetro /EMPRESA=ML-4821-ECV (instalação em massa) e grava ao lado do programa.
!include "FileFunc.nsh"
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
!macroend
