# Registers a Windows scheduled task that runs auto-pull.ps1 every 10 minutes
# for the current user. Re-run to update; remove with:
#   Unregister-ScheduledTask -TaskName 'SAG AI Office auto-pull' -Confirm:$false

$script = Join-Path $PSScriptRoot 'auto-pull.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 9) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName 'SAG AI Office auto-pull' -Action $action -Trigger $trigger `
    -Settings $settings -Description 'git fetch + fast-forward pull of D:\sag-ai-office every 10 minutes' -Force | Out-Null
Write-Output "Registered 'SAG AI Office auto-pull' (every 10 minutes)."
