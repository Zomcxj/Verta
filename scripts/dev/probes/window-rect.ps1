param([string]$Out = "D:\VsPro\Verta\.superpowers\shots\desktop.png")

# Print the app's visible window rect and grab a full screenshot along the way.
#
# Uses the OS's GetWindowRect instead of `window.screenX` in the page: by the time a screen capture is taken
# the window may have moved, or the app may have quit, and coordinates read from the page then point at some
# other window (one wasted round).
# Note that `param` must stay on the first line -- this file is UTF-8 without a BOM, Windows PowerShell 5.1
# decodes it as ANSI, and a non-ASCII comment ahead of `param` makes the whole script fail to parse with all
# arguments turning empty. (That is also why this file keeps every comment ASCII-only.)

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
