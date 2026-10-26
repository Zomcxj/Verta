param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Hex,
    [int]$Tolerance = 24,
    [int]$X = 0,
    [int]$Y = 0,
    [int]$W = 0,
    [int]$H = 0
)

# How many pixels of one region are a given colour, within a tolerance?
#
# A badge on a tray icon is a handful of pixels inside a picture thousands of times its
# size, so the region's dominant colours do not move when it appears: counting the colour
# itself is what settles "is the dot there" and "is it gone again", and the bounding box of
# the hits says *where* it is. Region defaults to the whole image.
#
# Usage: powershell -File png-count-color.ps1 -Path tray.png -Hex F59E0B -Tolerance 24
# ASCII only on purpose: PS 5.1 reads this file as ANSI without a BOM, and non-ASCII
# comments break the parser.
Add-Type -AssemblyName System.Drawing

$img = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Path).Path)
if ($W -le 0) { $W = $img.Width - $X }
if ($H -le 0) { $H = $img.Height - $Y }
$wantR = [Convert]::ToInt32($Hex.Substring(0, 2), 16)
$wantG = [Convert]::ToInt32($Hex.Substring(2, 2), 16)
$wantB = [Convert]::ToInt32($Hex.Substring(4, 2), 16)

$hits = 0
$minX = $X + $W
$minY = $Y + $H
$maxX = -1
$maxY = -1
for ($py = $Y; $py -lt ($Y + $H); $py++) {
    for ($px = $X; $px -lt ($X + $W); $px++) {
        $c = $img.GetPixel($px, $py)
        if ([Math]::Abs($c.R - $wantR) -le $Tolerance -and
            [Math]::Abs($c.G - $wantG) -le $Tolerance -and
            [Math]::Abs($c.B - $wantB) -le $Tolerance) {
            $hits++
            if ($px -lt $minX) { $minX = $px }
            if ($px -gt $maxX) { $maxX = $px }
            if ($py -lt $minY) { $minY = $py }
            if ($py -gt $maxY) { $maxY = $py }
        }
    }
}
$img.Dispose()

if ($hits -gt 0) {
    Write-Output ("{0}: hex={1} tol={2} pixels={3} bbox={4},{5}..{6},{7}" -f $Path, $Hex, $Tolerance, $hits, $minX, $minY, $maxX, $maxY)
} else {
    Write-Output ("{0}: hex={1} tol={2} pixels=0" -f $Path, $Hex, $Tolerance)
}