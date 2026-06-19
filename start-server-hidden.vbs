Option Explicit

Dim shell, fileSystem, root, port, provider
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
root = fileSystem.GetParentFolderName(WScript.ScriptFullName)
port = "8787"
provider = "hybrid"
If WScript.Arguments.Count > 0 Then port = WScript.Arguments(0)
If WScript.Arguments.Count > 1 Then provider = WScript.Arguments(1)
shell.CurrentDirectory = root
shell.Environment("Process")("PORT") = port
shell.Environment("Process")("DATA_PROVIDER") = provider
shell.Run "cmd.exe /c node.exe server/index.js > server-" & port & ".log 2> server-" & port & ".err.log", 0, False
WScript.Quit 0
