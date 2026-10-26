param([int]$X = 0, [int]$Y = 0)
# Click one point on the desktop with real input.
#
# Why this exists: Windows will not let a process that is not already in front raise a
# window (SetForegroundWindow is refused, and `set_focus` from the page is the same call),
# so the only way to put a window in front from a script is to click it - the shell's own
# activation on a mouse message is allowed. The notifications acceptance needs the same
# thing to click a toast, which the web view does not draw.
#
# ASCII only on purpose: PS 5.1 reads this file as ANSI without a BOM.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DesktopClick {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(90);
    mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(50);
    mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
  }
}
"@
[DesktopClick]::Click($X, $Y)
Write-Output "clicked $X,$Y"