' Runs a command without a console window (used by Windows scheduled tasks and autostart).
' Usage: wscript run-hidden.vbs "C:\path\node.exe" "C:\path\script.mjs" arg1 arg2
Set shell = CreateObject("WScript.Shell")
cmd = ""
For Each a In WScript.Arguments
  cmd = cmd & " """ & a & """"
Next
shell.Run Trim(cmd), 0, False
