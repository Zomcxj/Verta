param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$TilesX = 8,
    [int]$TilesY = 6,
    [double]$Min = 5,
    [double]$Max = 90
)

# Tile a PNG and report each tile's luma delta (max - min luma). Text and icons
# light up a tile to delta 200+, a texture sits in the 5..60 band, so the filter
# below is what makes a texture findable at all. ASCII only: PS 5.1 reads this
# file as ANSI without a BOM and non-ASCII comments break the parser.
Add-Type -AssemblyName System.Drawing

$bmp = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Path).Path)
$tw = [int]($bmp.Width / $TilesX)
$th = [int]($bmp.Height / $TilesY)
$out = @()

for ($ty = 0; $ty -lt $TilesY; $ty++) {
    for ($tx = 0; $tx -lt $TilesX; $tx++) {
        $x0 = $tx * $tw; $y0 = $ty * $th
        $minL = 255.0; $maxL = 0.0; $sum = 0.0; $n = 0
        for ($py = $y0; $py -lt [Math]::Min($y0 + $th, $bmp.Height); $py++) {
            for ($px = $x0; $px -lt [Math]::Min($x0 + $tw, $bmp.Width); $px++) {
                $c = $bmp.GetPixel($px, $py)
                $l = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
                if ($l -lt $minL) { $minL = $l }
                if ($l -gt $maxL) { $maxL = $l }
                $sum += $l; $n++
            }
        }
        $delta = $maxL - $minL
        if ($delta -ge $Min -and $delta -le $Max) {
            $out += [PSCustomObject]@{
                tile  = "x$($x0 + [int]($tw / 2)),y$($y0 + [int]($th / 2))"
                size  = "${tw}x${th}"
                delta = [Math]::Round($delta, 1)
                mean  = [Math]::Round($sum / $n, 1)
            }
        }
    }
}
$bmp.Dispose()
Write-Output "-- $Path tiles=$TilesX x $TilesY size=${tw}x${th}, delta in [$Min,$Max] --"
$out | Sort-Object -Property delta -Descending | Select-Object -First 14 | Format-Table -AutoSize