param([string]$In, [string]$Out, [int]$X, [int]$Y, [int]$W, [int]$H)
# Cut one region out of a PNG so a small part of a large screenshot can be looked at
# directly. Region screenshots are the only way to see OS-level chrome (a taskbar button,
# a window caption), and a full-desktop picture is too large to read one button in.
# ASCII only on purpose: PS 5.1 reads this file as ANSI without a BOM.
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($In)
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$src = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
$dst = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$g.DrawImage($img, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
$img.Dispose()
Write-Output "$Out $($W)x$($H) from $X,$Y"
