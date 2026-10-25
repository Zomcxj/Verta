# Watch every `gh` process start, from outside the app, for as long as the stop file is absent.
#
# Every GitHub read in the app shells out to `gh` (`src-tauri/src/modules/github/gh.rs` uses
# `Command::new("gh")`), so counting gh starts answers "did this panel ask GitHub again" without reading
# anything out of the app. `repo-list-refresh.mjs` pairs with this file: it prints epoch-millisecond marks
# around each open, and the two sides are lined up afterwards.
#
# A poll rather than a WMI start trace: `Register-WmiEvent` on `Win32_ProcessStartTrace` comes back
# "Access denied" without elevation, and a read over the network keeps its process alive long enough
# (spawn, TLS handshake, request) for a 60 ms poll to see it. Each process is recorded once, keyed by pid.
#
# Nothing is written except the log in the temp folder; the app is only observed.
$log = Join-Path $env:TEMP "v\gh-watch.log"
$stop = Join-Path $env:TEMP "v\gh-watch.stop"
Remove-Item -Force $log, $stop -ErrorAction SilentlyContinue
Add-Content -Path $log -Value "ready" -Encoding utf8

$seen = @{}
while (-not (Test-Path $stop)) {
  foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='gh.exe'" -ErrorAction SilentlyContinue)) {
    $key = "$($p.ProcessId)"
    if (-not $seen.ContainsKey($key)) {
      $seen[$key] = $true
      if ($p.CommandLine) {
        Add-Content -Path $log -Value ("{0} {1}" -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), $p.CommandLine) -Encoding utf8
      }
    }
  }
  Start-Sleep -Milliseconds 60
}