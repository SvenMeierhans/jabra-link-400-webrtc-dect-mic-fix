<#
.SYNOPSIS
  Dumps the HID report layout (usage pages, usages, report IDs) of a device. Read-only.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File lab\hid\hidinfo.ps1 -Match "vid_0b0e&pid_1131"
#>
param([string]$Match = 'vid_0b0e&pid_1131')   # Jabra Link 400; use your dongle's VID/PID
Add-Type -TypeDefinition (Get-Content -Raw (Join-Path $PSScriptRoot 'HidInfo.cs'))
[HidInfo]::Dump($Match)
