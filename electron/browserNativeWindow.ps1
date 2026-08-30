param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("capture", "hide", "show")]
  [string]$Action,
  [string]$ProfileDir,
  [Int64[]]$Handles = @()
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ImageChatGPTNativeWindow {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
'@

function Write-Result([bool]$Ok, [Int64[]]$WindowHandles, [int]$Changed, [string]$ErrorMessage) {
  @{ ok = $Ok; handles = @($WindowHandles); changed = $Changed; error = $ErrorMessage } |
    ConvertTo-Json -Compress
}

try {
  if ($Action -eq "capture") {
    if ([string]::IsNullOrWhiteSpace($ProfileDir)) { throw "缺少 ProfileDir" }
    $resolved = [IO.Path]::GetFullPath($ProfileDir).ToLowerInvariant()
    $processes = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($resolved) }
    $found = [System.Collections.Generic.List[Int64]]::new()
    foreach ($process in $processes) {
      try {
        $handle = [Diagnostics.Process]::GetProcessById([int]$process.ProcessId).MainWindowHandle.ToInt64()
        if ($handle -ne 0 -and -not $found.Contains($handle)) { [void]$found.Add($handle) }
      } catch {
        # Browser subprocess may terminate between the CIM query and this lookup.
      }
    }
    Write-Result $true $found.ToArray() 0 ""
    exit 0
  }

  $command = if ($Action -eq "hide") { 0 } else { 9 } # SW_HIDE / SW_RESTORE
  $changed = 0
  foreach ($handleValue in $Handles) {
    if ($handleValue -eq 0) { continue }
    $handle = [IntPtr]::new($handleValue)
    if ([ImageChatGPTNativeWindow]::ShowWindowAsync($handle, $command)) { $changed += 1 }
  }
  Write-Result $true $Handles $changed ""
  exit 0
} catch {
  Write-Result $false @() 0 ($_.Exception.Message)
  exit 1
}
