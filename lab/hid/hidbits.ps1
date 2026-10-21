<#
.SYNOPSIS
  COMPUTES the HID output reports that set one usage each (Off-Hook, Mute, ...). Nothing is sent to the device.
.DESCRIPTION
  Use the telephony collection (usage page 0x000B, usage 0x0005) of your dongle: `hidinfo.ps1` shows its collection
  number (colNN) and report ID. The LED usage page is 0x08: Off-Hook 0x17, Mute 0x09, Hold 0x20, Microphone 0x21,
  Online 0x2A, Ring 0x18 (never send Ring: it makes the headset ring).
  The result for the Off-Hook usage is what you pass as `offHookMask` (second byte of the report) to `configureHook()`.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File lab\hid\hidbits.ps1 -Match "vid_0b0e&pid_1131" -Col col02 -ReportId 2
#>
param(
  [string]$Match = 'vid_0b0e&pid_1131',
  [string]$Col = 'col02',
  [byte]$ReportId = 2
)
Add-Type -TypeDefinition (Get-Content -Raw (Join-Path $PSScriptRoot 'HidInfo.cs'))
foreach ($u in 0x17, 0x09, 0x20, 0x21, 0x2A) { [HidInfo]::BuildOutput($Match, $Col, $ReportId, 0x08, $u) }
