# 区域截图验收：把整个（虚拟）桌面拍下来。
#
# 为什么不用覆盖窗口自己的 CDP 截图：那个窗口现在是**透明**的，CDP 只会给出页面自己画的东西
# （灰层、选择框），看不到「屏幕本身透出来了吗」「覆盖窗口之外有没有被挡住」。要验的恰好是这
# 一件事，所以只能从系统这一层拍桌面。
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