# Move the dev build's main window to a given screen position, for acceptance of code that places
# another window relative to it (Settings centres on the main window, so the check has to move the
# main window somewhere off-centre first). (ASCII-only comments: PowerShell 5.1 reads this file as ANSI.)
# The process is picked by executable path for the same reason shot-window.ps1 does it: a released
# build is installed on this machine too, and the process name alone would move that window instead.
# The largest visible window is the main one; this app also owns a 16x16 helper window.
# Coordinates are physical pixels, which is what the page reports as screenX/screenY, so the caller
# works them out from the page's own metrics rather than from a second opinion about DPI.
param(
    [string]$ProcName = "verta",
    [string]$ExeMatch = "target\debug\verta.exe",
    [int]$X = 0,
    [int]$Y = 0,
    [int]$WaitMs = 9000
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Move {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

    public static IntPtr LargestVisibleWindow(uint target) {
        IntPtr best = IntPtr.Zero;
        long bestArea = 0;
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid != target || !IsWindowVisible(h)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            long area = (long)(r.R - r.L) * (long)(r.B - r.T);
            if (area > bestArea) { bestArea = area; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }
}
"@

$deadline = (Get-Date).AddMilliseconds($WaitMs)
$h = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
    $proc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -like "*$ExeMatch*" } |
        Select-Object -First 1
    if ($proc) {
        $h = [Move]::LargestVisibleWindow([uint32]$proc.Id)
        if ($h -ne [IntPtr]::Zero) { break }
    }
    Start-Sleep -Milliseconds 250
}
if ($h -eq [IntPtr]::Zero) {
    Write-Error "No visible window of $ProcName matching '$ExeMatch'"
    exit 1
}

$before = New-Object Move+RECT
[void][Move]::GetWindowRect($h, [ref]$before)
# SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE: move only, so focus stays where the user had it.
[void][Move]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, 0, 0, 0x0015)
Start-Sleep -Milliseconds 400
$after = New-Object Move+RECT
[void][Move]::GetWindowRect($h, [ref]$after)
Write-Host "window before=$($before.L),$($before.T) after=$($after.L),$($after.T)"
