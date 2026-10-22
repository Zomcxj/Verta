param([string]$Out = "D:\VsPro\Verta\.superpowers\shots\desktop.png")

# 打印应用的可见窗口矩形，并顺手把整屏拍下来。
#
# 用 OS 的 GetWindowRect 而不是页面里的 `window.screenX`：抓屏取证时窗口可能已经动了、
# 甚至应用已经退出，那时页面里读到的坐标会把量测引到别的窗口上去（白跑过一轮）。
# 注意 `param` 必须在第一行 —— 这个文件是 UTF-8 无 BOM，Windows PowerShell 5.1 会按
# ANSI 解码，中文注释排在 `param` 前面时整个脚本会解析失败、参数全变空。

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class WinRect {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@

$found = $false
Get-Process -Name verta -ErrorAction SilentlyContinue | ForEach-Object {
  $rect = New-Object RECT
  if ([WinRect]::GetWindowRect($_.MainWindowHandle, [ref]$rect)) {
    $visible = [WinRect]::IsWindowVisible($_.MainWindowHandle)
    Write-Output ("visible={0} rect={1},{2},{3},{4}" -f $visible, $rect.L, $rect.T, $rect.R, $rect.B)
    $found = $true
  }
}
if (-not $found) { Write-Output "no-window" }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()
Write-Output "shot=$Out origin=$($bounds.X),$($bounds.Y) size=$($bounds.Width)x$($bounds.Height)"
