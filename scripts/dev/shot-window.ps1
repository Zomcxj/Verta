# 按进程名 + 可执行文件路径抓窗口截图，用于逐期验收（PrintWindow，不依赖前台焦点）。
# 必须按路径过滤：本机同时装着正式版 terax 时，只按进程名会抓到别人的窗口。
param(
    [string]$ProcName = "terax",
    [string]$ExeMatch = "target\debug\terax.exe",
    [string]$Out = "docs\superpowers\shots\shot.png",
    [int]$WaitMs = 9000
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$deadline = (Get-Date).AddMilliseconds($WaitMs)
$proc = $null
while (-not $proc -and (Get-Date) -lt $deadline) {
    $proc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -like "*$ExeMatch*" -and $_.MainWindowHandle -ne [IntPtr]::Zero } |
        Select-Object -First 1
    if (-not $proc) { Start-Sleep -Milliseconds 250 }
}
if (-not $proc) {
    $seen = Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
        ForEach-Object { "  pid=$($_.Id) path=$($_.Path) hwnd=$($_.MainWindowHandle)" }
    Write-Error "未找到匹配 '$ExeMatch' 的 $ProcName 可见窗口。当前同名进程：`n$($seen -join "`n")"
    exit 1
}

Write-Host "目标进程 pid=$($proc.Id) path=$($proc.Path)"

$h = $proc.MainWindowHandle
$r = New-Object Win+RECT
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