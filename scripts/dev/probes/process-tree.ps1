param(
    [string]$Names = "bash|node|pi|opencode|conhost|winpty|sh|wsl"
)
# The shells and agents Verta starts, listed flat with their parent ids, plus a marker for
# "this process's recorded parent is not in the list at all" (a launcher that exited).
#
# Used to see what a "does this terminal have a command running" walk actually sees: the
# walk descends through a launcher while it has exactly one child that is a shell, so this
# is the shape that decides the answer.
#
# Measured here (2026-10-26): opencode.exe was recorded with a parent pid that no longer
# existed, so walking down from the shell found no children while the agent was running.
# Windows records the parent when the process is *created*, and a launcher that exits
# immediately leaves its pid behind to be reused, so the recorded parent can point at an
# unrelated process - or at one that is long gone. A flat list is the honest view: the tree
# printed from these rows has cycles in it, which is the whole point.
#
# ASCII only on purpose: PS 5.1 reads this file as ANSI without a BOM.
$all = Get-CimInstance Win32_Process | Where-Object { $_.Name -match $Names }
$listed = @{}
foreach ($proc in $all) { $listed[[string]$proc.ProcessId] = $true }
$rows = foreach ($proc in ($all | Sort-Object ParentProcessId)) {
    $cmd = ($proc.CommandLine -replace "\s+", " ")
    if ($cmd.Length -gt 78) { $cmd = $cmd.Substring(0, 78) }
    $orphan = "-"
    if (-not $listed.ContainsKey([string]$proc.ParentProcessId)) { $orphan = "parent-not-listed" }
    [pscustomobject]@{
        pid = $proc.ProcessId
        parent = $proc.ParentProcessId
        name = $proc.Name
        orphan = $orphan
        cmd = $cmd
    }
}
$rows | Format-Table -AutoSize | Out-String -Width 200 | Write-Output