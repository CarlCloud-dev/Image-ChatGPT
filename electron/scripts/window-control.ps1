param(
  [int]$TargetPid = 0,
  [string]$ProfileDir = "",
  [ValidateSet("show", "hide", "visible")]
  [string]$Action = "visible"
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class Win32WindowControl {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
}
"@

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

if ($TargetPid -gt 0) {
  [void]$candidatePids.Add($TargetPid)
}

try {
  $chromeProcs = @(Get-CimInstance Win32_Process -Filter "name = 'chrome.exe'" -ErrorAction SilentlyContinue)
  foreach ($proc in $chromeProcs) {
    $cmd = Normalize-PathText ($proc.CommandLine)
    if (Text-Contains $cmd $profileNeedle) {
      [void]$candidatePids.Add([int]$proc.ProcessId)
    }
  }

  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($proc in $chromeProcs) {
      if ($candidatePids.Contains([int]$proc.ParentProcessId) -and -not $candidatePids.Contains([int]$proc.ProcessId)) {
        [void]$candidatePids.Add([int]$proc.ProcessId)
        $changed = $true
      }
    }
  }
} catch {
  # Ignore process query failures; fallback below still works for direct PID.
}

$matches = New-Object System.Collections.Generic.List[object]
$fallbackMatches = New-Object System.Collections.Generic.List[object]
$offscreenMatches = New-Object System.Collections.Generic.List[object]

$callback = [Win32WindowControl+EnumWindowsProc]{
  param([IntPtr]$hwnd, [IntPtr]$lparam)

  $classBuilder = New-Object System.Text.StringBuilder 256
  [void][Win32WindowControl]::GetClassName($hwnd, $classBuilder, $classBuilder.Capacity)
  $className = $classBuilder.ToString()
  if ($className -ne "Chrome_WidgetWin_1") { return $true }

  $titleBuilder = New-Object System.Text.StringBuilder 512
  [void][Win32WindowControl]::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity)
  $title = $titleBuilder.ToString()

  [uint32]$windowPid = 0
  [void][Win32WindowControl]::GetWindowThreadProcessId($hwnd, [ref]$windowPid)
  if ($windowPid -eq 0) { return $true }
  $rect = New-Object Win32WindowControl+RECT
  [void][Win32WindowControl]::GetWindowRect($hwnd, [ref]$rect)
  $isOffscreen = ($rect.Left -lt -10000 -or $rect.Top -lt -10000)
  $isMinimized = [Win32WindowControl]::IsIconic($hwnd)

  $matched = $false
  if ($candidatePids.Contains([int]$windowPid)) {
    $matched = $true
  }

  if ($matched) {
    $matches.Add([pscustomobject]@{
      Hwnd = $hwnd
      Pid = [int]$windowPid
      Title = $title
      Visible = [Win32WindowControl]::IsWindowVisible($hwnd)
      Left = $rect.Left
      Top = $rect.Top
      Minimized = $isMinimized
    }) | Out-Null
  } elseif ($title -match "ChatGPT|Image-ChatGPT") {
    $fallbackMatches.Add([pscustomobject]@{
      Hwnd = $hwnd
      Pid = [int]$windowPid
      Title = $title
      Visible = [Win32WindowControl]::IsWindowVisible($hwnd)
      Left = $rect.Left
      Top = $rect.Top
      Minimized = $isMinimized
    }) | Out-Null
  } elseif ($isOffscreen) {
    $offscreenMatches.Add([pscustomobject]@{
      Hwnd = $hwnd
      Pid = [int]$windowPid
      Title = $title
      Visible = [Win32WindowControl]::IsWindowVisible($hwnd)
      Left = $rect.Left
      Top = $rect.Top
      Minimized = $isMinimized
    }) | Out-Null
  }

  return $true
}

[void][Win32WindowControl]::EnumWindows($callback, [IntPtr]::Zero)

if ($matches.Count -eq 0 -and $fallbackMatches.Count -gt 0) {
  foreach ($m in $fallbackMatches) { $matches.Add($m) | Out-Null }
}

if ($matches.Count -eq 0 -and $offscreenMatches.Count -gt 0) {
  foreach ($m in $offscreenMatches) { $matches.Add($m) | Out-Null }
}

if ($matches.Count -eq 0) {
  $debugPids = @()
  foreach ($candidatePid in $candidatePids) { $debugPids += [int]$candidatePid }
  @{ ok = $false; visible = $false; error = "window_not_found"; candidatePids = $debugPids; offscreenCount = $offscreenMatches.Count } | ConvertTo-Json -Compress
  exit 2
}

$target = $matches | Where-Object { -not [string]::IsNullOrWhiteSpace($_.Title) -and $_.Title -match "ChatGPT|Image-ChatGPT|Google Chrome" } | Select-Object -First 1
if ($null -eq $target) {
  $target = $matches | Where-Object { -not [string]::IsNullOrWhiteSpace($_.Title) } | Select-Object -First 1
}
if ($null -eq $target) {
  $target = $matches[0]
}
$hwnd = [IntPtr]$target.Hwnd

if ($Action -eq "hide") {
  foreach ($m in $matches) {
    [void][Win32WindowControl]::ShowWindow([IntPtr]$m.Hwnd, 0)
  }
  @{ ok = $true; visible = $false; pid = $target.Pid; count = $matches.Count; title = $target.Title } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq "show") {
  foreach ($m in $matches) {
    if ([IntPtr]$m.Hwnd -ne $hwnd) {
      [void][Win32WindowControl]::ShowWindow([IntPtr]$m.Hwnd, 0)
    }
  }
  [void][Win32WindowControl]::ShowWindow($hwnd, 9)
  [void][Win32WindowControl]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 1280, 900, 0x0040)
  [void][Win32WindowControl]::ShowWindow($hwnd, 5)
  [void][Win32WindowControl]::BringWindowToTop($hwnd)
  [void][Win32WindowControl]::SetForegroundWindow($hwnd)
  @{ ok = $true; visible = $true; pid = $target.Pid; count = $matches.Count; title = $target.Title } | ConvertTo-Json -Compress
  exit 0
}

$anyVisible = $false
foreach ($m in $matches) {
  if ([Win32WindowControl]::IsWindowVisible([IntPtr]$m.Hwnd)) {
    $anyVisible = $true
    break
  }
}
@{ ok = $true; visible = [bool]$anyVisible; pid = $target.Pid; count = $matches.Count; title = $target.Title } | ConvertTo-Json -Compress
