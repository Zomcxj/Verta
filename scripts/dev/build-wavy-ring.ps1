param(
    [int]$Points = 720,
    [double]$Inner = 100,
    [double]$Amplitude = 7.5,
    [int]$Waves = 9
)

# Ring with a sine ripple around it, as an SVG path (closed Catmull-Rom).
# The stroke lives in this path, so the ripple is a cosine wave of constant
# wavelength along the circumference -- a blurred circle can only change its
# stroke width or wobble as a whole, neither of which reads as a wave.
#
# r(theta) = inner + amplitude/2 + amplitude/2 * sin(PI/2 + waves*theta):
# the stroked centre line sits at `inner`, and a crest lands exactly at the
# top, which is what the eye reads first.
#
# Output: pure path data on one line ("M ... C ... Z"). The caller wraps it in
# `url("data:image/svg+xml,...")` with a fixed stroke, so this stays reusable.
#
# ASCII only: PS 5.1 reads this file as ANSI without a BOM and non-ASCII
# comments break the parser.

$inv = [System.Globalization.CultureInfo]::InvariantCulture
function F($v) { ([Math]::Round($v, 2)).ToString($inv) }

$centre = $Inner + $Amplitude / 2
$xs = New-Object 'double[]' $Points
$ys = New-Object 'double[]' $Points
for ($i = 0; $i -lt $Points; $i++) {
    $theta = 2 * [Math]::PI * $i / $Points
    $r = $centre + ($Amplitude / 2) * [Math]::Sin([Math]::PI / 2 + $Waves * $theta)
    $xs[$i] = $r * [Math]::Cos($theta)
    $ys[$i] = $r * [Math]::Sin($theta)
}

$sb = New-Object System.Text.StringBuilder
[void]$sb.Append("M $(F $xs[0]) $(F $ys[0])")
for ($i = 0; $i -lt $Points; $i++) {
    $p0 = ($i - 1 + $Points) % $Points
    $p2 = ($i + 1) % $Points
    $p3 = ($i + 2) % $Points
    $c1x = $xs[$i] + ($xs[$p2] - $xs[$p0]) / 6
    $c1y = $ys[$i] + ($ys[$p2] - $ys[$p0]) / 6
    $c2x = $xs[$p2] - ($xs[$p3] - $xs[$i]) / 6
    $c2y = $ys[$p2] - ($ys[$p3] - $ys[$i]) / 6
    [void]$sb.Append(" C $(F $c1x) $(F $c1y) $(F $c2x) $(F $c2y) $(F $xs[$p2]) $(F $ys[$p2])")
}
[void]$sb.Append(" Z")
[Console]::Out.Write($sb.ToString())