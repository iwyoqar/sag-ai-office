# Fetches origin and fast-forwards the current branch when GitHub has new commits.
# Run by the "SAG AI Office auto-pull" scheduled task every 10 minutes
# (see scripts/register-auto-pull.ps1). Never discards local work: a dirty
# working tree or a diverged branch is logged and skipped.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repo 'data'
$log = Join-Path $logDir 'auto-pull.log'
New-Item -ItemType Directory -Force $logDir | Out-Null

function Write-Log($msg) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $log -Value $line -Encoding utf8
}

# Keep the log from growing forever.
if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) {
    Get-Content $log -Tail 2000 | Set-Content $log -Encoding utf8
}

Set-Location $repo
try {
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    git fetch --quiet origin 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Log 'fetch failed (offline?)'; exit 1 }

    $local = (git rev-parse HEAD).Trim()
    $remote = (git rev-parse "origin/$branch").Trim()
    if ($local -eq $remote) { exit 0 }

    $base = (git merge-base HEAD "origin/$branch").Trim()
    if ($base -eq $remote) { exit 0 }  # only local commits ahead; nothing to pull
    if ($base -ne $local) { Write-Log "skip: $branch has diverged from origin/$branch"; exit 1 }

    if (git status --porcelain --untracked-files=no) {
        Write-Log 'skip: uncommitted changes in working tree'
        exit 1
    }

    $changed = git diff --name-only $local $remote
    git merge --ff-only --quiet "origin/$branch" 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Log 'merge --ff-only failed'; exit 1 }
    Write-Log ("pulled {0}..{1} ({2} files)" -f $local.Substring(0,7), $remote.Substring(0,7), @($changed).Count)

    if ($changed -match '(^|/)package(-lock)?\.json$') {
        Write-Log 'package files changed, running npm install'
        npm install --no-audit --no-fund 2>&1 | Out-Null
        Write-Log "npm install exit $LASTEXITCODE"
    }
} catch {
    Write-Log "error: $_"
    exit 1
}
