param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$X = 0,
    [int]$Y = 0,
    [int]$W = 0,
    [int]$H = 0
)

# Pixel stats for one rectangle of a PNG: mean colour, luma range, most common
# colours. The luma delta is how strongly a texture shows in that area --
# "it looks faint" / "I cannot see it" is a lot easier to settle with numbers.
# Usage: powershell -File png-region-stats.ps1 -Path shot.png -X 20 -Y 200 -W 200 -H 400
# ASCII only on purpose: PS 5.1 reads this file as ANSI without a BOM, and
# non-ASCII comments break the parser.
Add-Type -AssemblyName System.Drawing

$bmp = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Path).Path)
if ($W -le 0) { $W = $bmp.Width - $X }
if ($H -le 0) { $H = $bmp.Height - $Y }

$sumR = 0.0; $sumG = 0.0; $sumB = 0.0
$minL = 255.0; $maxL = 0.0; $n = 0
$hist = @{}
# Step of 2: the weave is a fine line, a coarser step would miss it entirely.
for ($py = $Y; $py -lt ($Y + $H); $py += 2) {
    for ($px = $X; $px -lt ($X + $W); $px += 2) {
        if ($px -ge $bmp.Width -or $py -ge $bmp.Height) { continue }
        $c = $bmp.GetPixel($px, $py)
        $sumR += $c.R; $sumG += $c.G; $sumB += $c.B
        $l = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
        if ($l -lt $minL) { $minL = $l }
        if ($l -gt $maxL) { $maxL = $l }
        $key = "$($c.R),$($c.G),$($c.B)"
        if ($hist.ContainsKey($key)) { $hist[$key] = $hist[$key] + 1 } else { $hist[$key] = 1 }
        $n++
    }
}
$bmp.Dispose()

$top = $hist.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 4
[PSCustomObject]@{
    file      = (Split-Path $Path -Leaf)
    region    = "x=$X y=$Y ${W}x${H}"
    samples   = $n
    meanRgb   = "{0:N1} {1:N1} {2:N1}" -f ($sumR / $n), ($sumG / $n), ($sumB / $n)
    lumaRange = "{0:N1} .. {1:N1} (delta {2:N1})" -f $minL, $maxL, ($maxL - $minL)
    topColors = ($top | ForEach-Object { "$($_.Key) x$($_.Value)" }) -join " | "
} | Format-List