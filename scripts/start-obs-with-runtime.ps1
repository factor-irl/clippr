<#!
.SYNOPSIS
    Launches OBS and the Reward Playback Runtime together.
.DESCRIPTION
    Starts the configured OBS executable, waits for a short delay, then starts
    the Reward Playback Runtime executable in run mode. Adjust the variables
    below to match your installation paths.
!>

param (
    [string]$ObsExe = "C:\Program Files\obs-studio\bin\64bit\obs64.exe",
    [string]$RuntimeExe = "C:\stream-tools\reward-runtime.exe",
    [int]$DelaySeconds = 3
)

function Assert-PathExists {
    param (
        [Parameter(Mandatory = $true)] [string]$Path,
        [Parameter(Mandatory = $true)] [string]$Label
    )

    if (-not (Test-Path -Path $Path)) {
        Write-Error "$Label not found at '$Path'. Update scripts/start-obs-with-runtime.ps1 with the correct path."
        exit 1
    }
}

Assert-PathExists -Path $ObsExe -Label "OBS executable"
Assert-PathExists -Path $RuntimeExe -Label "Reward runtime executable"

Write-Host "Starting OBS from $ObsExe" -ForegroundColor Cyan
Start-Process -FilePath $ObsExe

if ($DelaySeconds -gt 0) {
    Write-Host "Waiting $DelaySeconds second(s) for OBS to initialize..."
    Start-Sleep -Seconds $DelaySeconds
}

$runtimeDir = Split-Path -Parent $RuntimeExe
Write-Host "Starting Reward Playback Runtime (run mode) from $RuntimeExe" -ForegroundColor Cyan
Start-Process -FilePath $RuntimeExe -ArgumentList "run" -WorkingDirectory $runtimeDir

Write-Host "OBS and Reward Playback Runtime launched." -ForegroundColor Green
