param(
  [string]$ProfileDir = "",
  [ValidateSet("list", "kill")]
  [string]$Action = "list"
)

$ErrorActionPreference = "Stop"

function Normalize-PathText([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  return $Value.Trim().Replace("/", "\").TrimEnd("\")
}

function Text-Contains([string]$Haystack, [string]$Needle) {
  if ([string]::IsNullOrWhiteSpace($Haystack) -or [string]::IsNullOrWhiteSpace($Needle)) { return $false }
  return $Haystack.ToLowerInvariant().Contains($Needle.ToLowerInvariant())
}

$profileNeedle = Normalize-PathText $ProfileDir
$candidatePids = New-Object 'System.Collections.Generic.HashSet[int]'
$chromeProcs = @()
$queryWarning = $null

try {
  $chromeProcs = @(Get-CimInstance Win32_Process -Filter "name = 'chrome.exe'" -ErrorAction SilentlyContinue)
} catch {
  $queryWarning = $_.Exception.Message
  $chromeProcs = @()
}

foreach ($proc in $chromeProcs) {
  try {
    $cmd = Normalize-PathText ($proc.CommandLine)
    if (Text-Contains $cmd $profileNeedle) {
      [void]$candidatePids.Add([int]$proc.ProcessId)
    }
  } catch {
    # A Chrome child can exit while WMI is reading it; ignore that process.
  }
}

$changed = $true
while ($changed) {
  $changed = $false
  foreach ($proc in $chromeProcs) {
    try {
      if ($candidatePids.Contains([int]$proc.ParentProcessId) -and -not $candidatePids.Contains([int]$proc.ProcessId)) {
        [void]$candidatePids.Add([int]$proc.ProcessId)
        $changed = $true
      }
    } catch {
      # Process metadata changed; skip this process.
    }
  }
}

$pids = @()
foreach ($candidatePid in $candidatePids) {
  $pids += [int]$candidatePid
}
$killed = @()

if ($Action -eq "kill" -and $pids.Count -gt 0) {
  $roots = @()
  foreach ($proc in $chromeProcs) {
    $processId = [int]$proc.ProcessId
    $ppid = [int]$proc.ParentProcessId
    if ($candidatePids.Contains($processId) -and -not $candidatePids.Contains($ppid)) {
      $roots += $processId
    }
  }
  if ($roots.Count -eq 0) { $roots = $pids }
  foreach ($rootPid in $roots) {
    try {
      & taskkill.exe /PID $rootPid /T /F | Out-Null
      $killed += $rootPid
    } catch {
      # Continue with the remaining process tree roots.
    }
  }
  Start-Sleep -Milliseconds 500
}

@{
  ok = $true
  action = $Action
  pids = $pids
  count = $pids.Count
  killed = $killed
  warning = $queryWarning
} | ConvertTo-Json -Compress
