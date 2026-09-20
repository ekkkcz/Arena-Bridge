' Arena Bridge - silent launcher (no console window)
'
' Why .vbs instead of .cmd:
'   1) a .cmd always shows a black console window
'   2) on zh-CN Windows cmd.exe reads .cmd as GBK, so UTF-8 Chinese
'      text inside would be parsed as broken commands
' wscript.exe has neither problem.

Option Explicit

Dim fso, shell, root, exe, appDir, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = root & "\node_modules\electron\dist\electron.exe"
appDir = root & "\desktop\app"

If Not fso.FileExists(exe) Then
  MsgBox "Electron runtime not found:" & vbCrLf & exe & vbCrLf & vbCrLf & _
         "Run start-desktop.cmd once, or open a terminal here and run: npm install", _
         48, "Arena Bridge"
  WScript.Quit 1
End If

If Not fso.FolderExists(appDir) Then
  MsgBox "App folder not found:" & vbCrLf & appDir, 48, "Arena Bridge"
  WScript.Quit 1
End If

' Clear an inherited ELECTRON_RUN_AS_NODE: it makes Electron run as
' plain Node, so no window would ever appear. (Safe if it does not exist.)
On Error Resume Next
Dim env
Set env = shell.Environment("PROCESS")
env("ELECTRON_RUN_AS_NODE") = ""
On Error GoTo 0

shell.CurrentDirectory = root

' Quote both paths; 0 = hidden console, False = do not wait.
cmd = """" & exe & """ """ & appDir & """"
On Error Resume Next
shell.Run cmd, 0, False
If Err.Number <> 0 Then
  MsgBox "Failed to start:" & vbCrLf & cmd & vbCrLf & vbCrLf & _
         "Error " & Err.Number & ": " & Err.Description, 16, "Arena Bridge"
  WScript.Quit 1
End If
On Error GoTo 0
