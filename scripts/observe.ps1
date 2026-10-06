param([int]$RootPid, [string]$OutputPath, [string]$StopPath)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class ShikigamiObservation {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc fn, IntPtr p);
  public static uint[] VisiblePids() {
    var ids = new HashSet<uint>();
    EnumWindows((h,p) => { uint id; GetWindowThreadProcessId(h,out id); if(IsWindowVisible(h)) ids.Add(id); return true; }, IntPtr.Zero);
    var result = new uint[ids.Count]; ids.CopyTo(result); return result;
  }
}
'@
$samples = [System.Collections.Generic.List[object]]::new()
$memory = [System.Collections.Generic.List[object]]::new()
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$nextMemory = 0
$ids = @($RootPid)
while (!(Test-Path -LiteralPath $StopPath) -and $watch.Elapsed.TotalMinutes -lt 4) {
  $point = [ShikigamiObservation+Point]::new()
  [void][ShikigamiObservation]::GetCursorPos([ref]$point)
  $foreground = [ShikigamiObservation]::GetForegroundWindow()
  [uint32]$foregroundPid = 0
  [void][ShikigamiObservation]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
  $samples.Add([pscustomobject]@{t=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();x=$point.X;y=$point.Y;foregroundPid=$foregroundPid;foregroundHandle=$foreground.ToInt64()})
  if ($watch.ElapsedMilliseconds -ge $nextMemory) {
    $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name)
    $ids = @($RootPid)
    do {
      $newIds = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object { [int]$_.ProcessId })
      $ids += $newIds
    } while ($newIds.Count -gt 0)
    $procs = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)
    $os = Get-CimInstance Win32_OperatingSystem
    $visible = @([ShikigamiObservation]::VisiblePids() | Where-Object { $_ -in $ids })
    $memory.Add([pscustomobject]@{t=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();pids=$ids;visiblePids=$visible;workingSetBytes=($procs | Measure-Object WorkingSet64 -Sum).Sum;privateBytes=($procs | Measure-Object PrivateMemorySize64 -Sum).Sum;freePhysicalBytes=[long]$os.FreePhysicalMemory*1024;processes=@($procs | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64)})
    $nextMemory = $watch.ElapsedMilliseconds + 1000
  }
  Start-Sleep -Milliseconds 50
}
@{sampling='50ms target; CIM memory sampling creates gaps';samples=$samples.ToArray();memory=$memory.ToArray();durationMs=$watch.ElapsedMilliseconds} | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $OutputPath -Encoding utf8
