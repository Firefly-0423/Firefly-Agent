param([string[]]$TestFiles = @())

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$vitest = Join-Path $projectRoot 'node_modules\vitest\vitest.mjs'
$node = (Get-Command node -ErrorAction Stop).Source
$outputRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$outputPrefix = "firefly-vitest-$PID-$([guid]::NewGuid().ToString('N'))"
$diagnosticRoot = Join-Path $outputRoot 'firefly-vitest-diagnostics'
New-Item -ItemType Directory -Force -Path $diagnosticRoot | Out-Null
$env:FIREFLY_VITEST_DIAGNOSTICS = $diagnosticRoot
$stdoutPath = Join-Path $diagnosticRoot "$outputPrefix.stdout.log"
$stderrPath = Join-Path $diagnosticRoot "$outputPrefix.stderr.log"
$preload = ([System.Uri](Join-Path $PSScriptRoot 'trace-vitest-workers.mjs')).AbsoluteUri
$arguments = @('--import', $preload, $vitest, 'run', '--reporter=verbose', '--logHeapUsage') + $TestFiles
$runner = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
$runner.WaitForExit()
Write-Output "[vitest-diagnostic] test-exit code=$($runner.ExitCode)"
Get-Content -LiteralPath $stdoutPath
Get-Content -LiteralPath $stderrPath
# Read-only timing summary of the verbose log (slowest files and cases); it never changes the exit code.
try { & $node (Join-Path $PSScriptRoot 'summarize-vitest-timing.mjs') $stdoutPath } catch { Write-Output "[timing] summary unavailable: $($_.Exception.Message)" }
exit $runner.ExitCode
