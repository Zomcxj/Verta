# 在 Verta 窗口的客户区坐标做一次真实点击，用于验收需要交互的界面。
# 只做一次按下/抬起，并在结束时把光标还原到点击前的位置。
param(
    [string]$ProcName = "terax",
    [string]$ExeMatch = "target\debug\terax.exe",
    [int]$X = 0,
    [int]$Y = 0,
    [int]$SettleMs = 900,
    [switch]$NoForeground
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Click {
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@

$proc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path -like "*$ExeMatch*" -and $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1
if (-not $proc) {
    Write-Error "未找到匹配 '$ExeMatch' 的 $ProcName 可见窗口"
    exit 1
}
$h = $proc.MainWindowHandle

$origin = New-Object Click+POINT
$origin.X = 0; $origin.Y = 0
[void][Click]::ClientToScreen($h, [ref]$origin)
$target = New-Object Click+POINT
$target.X = $origin.X + $X
$target.Y = $origin.Y + $Y

$saved = New-Object Click+POINT
[void][Click]::GetCursorPos([ref]$saved)

if (-not $NoForeground) {
    # SetForegroundWindow is refused when the calling process does not own the
    # foreground, and it fails silently; a synthetic ALT press lifts that
    # restriction, and the result is verified because an unactivated window
    # swallows the click into "just activating me".
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        if ([Click]::GetForegroundWindow() -eq $h) { break }
        [Click]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)   # ALT down
        [Click]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)   # ALT up
        [void][Click]::SetForegroundWindow($h)
        Start-Sleep -Milliseconds 300
    }
    if ([Click]::GetForegroundWindow() -ne $h) {
        Write-Warning "窗口未能置前，点击可能被其他窗口接走"
    }
    Start-Sleep -Milliseconds 250
}
Write-Host "点击客户区 ($X, $Y) -> 屏幕 ($($target.X), $($target.Y))  pid=$($proc.Id)"
[void][Click]::SetCursorPos($target.X, $target.Y)
Start-Sleep -Milliseconds 120
[Click]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)   # LEFTDOWN
Start-Sleep -Milliseconds 80
[Click]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)   # LEFTUP
Start-Sleep -Milliseconds $SettleMs

[void][Click]::SetCursorPos($saved.X, $saved.Y)
Write-Host "已还原光标到 ($($saved.X), $($saved.Y))"