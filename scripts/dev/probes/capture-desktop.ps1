# Region-screenshot acceptance: capture the whole (virtual) desktop.
#
# Why not use the overlay window's own CDP screenshot: that window is **transparent**, so CDP only returns what
# the page itself draws (the dim layer, the selection box) and cannot show "does the screen show through" or
# "is anything blocked outside the overlay". That is exactly what needs verifying, so the desktop has to be
# captured at the OS level. (ASCII-only comments here: PowerShell 5.1 reads this file as ANSI.)
param([string]$Out = "F:\VibeCoding_workspace\Verta\.superpowers\shots\desktop.png")

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()
Write-Output "$Out $($bounds.Width)x$($bounds.Height)"