[CmdletBinding()]
param(
    [ValidateSet("get-state", "play", "pause", "toggle", "next", "prev")]
    [string]$Action = "get-state"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1

    function Await-AsyncOp($asyncOp, $type) {
        $method = $asTaskGeneric.MakeGenericMethod($type)
        $task = $method.Invoke($null, @($asyncOp))
        $task.Wait()
        return $task.Result
    }

    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
    $manager = Await-AsyncOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $qqSession = $manager.GetSessions() |
        Where-Object { ([string]$_.SourceAppUserModelId) -ieq "QQMusic.exe" } |
        Select-Object -First 1

    if (-not $qqSession) {
        @{ ok = $true; found = $false; error = "QQ_MUSIC_SESSION_NOT_FOUND" } | ConvertTo-Json -Compress
        exit 0
    }

    if ($Action -ne "get-state") {
        switch ($Action) {
            "play" { $operation = $qqSession.TryPlayAsync() }
            "pause" { $operation = $qqSession.TryPauseAsync() }
            "toggle" { $operation = $qqSession.TryTogglePlayPauseAsync() }
            "next" { $operation = $qqSession.TrySkipNextAsync() }
            "prev" { $operation = $qqSession.TrySkipPreviousAsync() }
        }
        $accepted = Await-AsyncOp $operation ([bool])
        @{ ok = [bool]$accepted; found = $true; appId = [string]$qqSession.SourceAppUserModelId; action = $Action } | ConvertTo-Json -Compress
        exit 0
    }

    $media = Await-AsyncOp ($qqSession.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $playback = $qqSession.GetPlaybackInfo()
    $timeline = $qqSession.GetTimelineProperties()
    @{
        ok = $true
        found = $true
        appId = [string]$qqSession.SourceAppUserModelId
        title = if ($media) { [string]$media.Title } else { "" }
        artist = if ($media) { [string]$media.Artist } else { "" }
        albumTitle = if ($media) { [string]$media.AlbumTitle } else { "" }
        playbackStatus = if ($playback) { [string]$playback.PlaybackStatus } else { "Closed" }
        position = if ($timeline) { [double]$timeline.Position.TotalSeconds } else { 0.0 }
        duration = if ($timeline) { [double]$timeline.EndTime.TotalSeconds } else { 0.0 }
        canPlay = if ($playback -and $playback.Controls) { [bool]$playback.Controls.IsPlayEnabled } else { $false }
        canPause = if ($playback -and $playback.Controls) { [bool]$playback.Controls.IsPauseEnabled } else { $false }
        canNext = if ($playback -and $playback.Controls) { [bool]$playback.Controls.IsNextEnabled } else { $false }
        canPrev = if ($playback -and $playback.Controls) { [bool]$playback.Controls.IsPreviousEnabled } else { $false }
    } | ConvertTo-Json -Compress
} catch {
    @{ ok = $false; found = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress
}
