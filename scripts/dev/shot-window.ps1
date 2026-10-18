# 按进程名 + 可执行文件路径抓窗口截图，用于逐期验收（PrintWindow，不依赖前台焦点）。
# 必须按路径过滤：本机同时装着正式版 Terax（`D:\Softwaredata\Terax\terax.exe`）时，只按进程名会抓到别人的窗口。
# 选窗口也不能用 MainWindowHandle：本应用还带一个 16x16 的辅助窗，它会挑错，所以取该进程面积最大的可见窗。
param(
    [string]$ProcName = "verta",
    [string]$ExeMatch = "target\debug\verta.exe",
    [string]$Out = ".superpowers\shots\shot.png",
    [int]$WaitMs = 9000
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
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
$proc = $null
$h = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
    $proc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -like "*$ExeMatch*" } |
        Select-Object -First 1
    if ($proc) {
        $h = [Win]::LargestVisibleWindow([uint32]$proc.Id)
        if ($h -ne [IntPtr]::Zero) { break }
    }
    Start-Sleep -Milliseconds 250
}
if (-not $proc -or $h -eq [IntPtr]::Zero) {
    $seen = Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
        ForEach-Object { "  pid=$($_.Id) path=$($_.Path)" }
    Write-Error "未找到匹配 '$ExeMatch' 的 $ProcName 可见窗口。当前同名进程：`n$($seen -join "`n")"
    exit 1
}

Write-Host "目标进程 pid=$($proc.Id) path=$($proc.Path)"
Write-Host "窗口句柄 $h"

$r = New-Object Win+RECT
# A minimized window reports its icon-sized rect, and a window that is still
# being created reports a tiny one, which would silently produce a useless
# sliver, so wait for a usable size before capturing.
$sizeDeadline = (Get-Date).AddMilliseconds($WaitMs)
while ((Get-Date) -lt $sizeDeadline) {
    if ([Win]::IsIconic($h)) {
        Write-Host "窗口处于最小化，先还原"
        [void][Win]::ShowWindow($h, 9)   # 9 = SW_RESTORE
        Start-Sleep -Milliseconds 600
    }
    [void][Win]::GetWindowRect($h, [ref]$r)
    if (($r.R - $r.L) -ge 400 -and ($r.B - $r.T) -ge 300) { break }
    Start-Sleep -Milliseconds 250
}
Start-Sleep -Milliseconds 800   # let the webview paint after it has been sized
[void][Win]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L
$hh = $r.B - $r.T
Write-Host "窗口 ${w}x${hh}"

$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][Win]::PrintWindow($h, $hdc, 2)   # 2 = PW_RENDERFULLCONTENT，含 GPU 合成内容
$g.ReleaseHdc($hdc)
$g.Dispose()

$outPath = Join-Path (Get-Location) $Out
New-Item -ItemType Directory -Force -Path (Split-Path $outPath) | Out-Null
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "已保存 $outPath"