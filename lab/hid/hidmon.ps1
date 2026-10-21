<#
.SYNOPSIS
  Read-only monitor for the HID input reports of a DECT dongle (Windows).
.DESCRIPTION
  Opens every HID collection of the matching device with read access only and timestamps each input report.
  Run it while opening/closing the microphone to see the dongle's session start/end, hook switch and volume pulses.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File lab\hid\hidmon.ps1 -Seconds 60 -Match "vid_0b0e&pid_1131"
#>
param(
  [int]$Seconds = 30,
  [string]$Log = (Join-Path $PSScriptRoot '..\out\hid.log'),
  [string]$Match = 'vid_0b0e&pid_1131'   # Jabra Link 400; use your dongle's VID/PID
)
Add-Type -TypeDefinition (Get-Content -Raw (Join-Path $PSScriptRoot 'HidMon.cs'))
[HidMon]::Run($Log, $Seconds, $Match)
