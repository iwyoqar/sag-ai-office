# Fetches origin and rebases the current branch onto it when GitHub has new commits.
# Run by the "SAG AI Office auto-pull" scheduled task every 10 minutes
# (see scripts/register-auto-pull.ps1). Never discards local work: uncommitted
# edits are autostashed and restored, unpushed commits are replayed on top, and
# a conflict is rolled back and logged.

# Not 'Stop': Windows PowerShell turns git's progress messages on stderr into
# terminating errors. Failures are checked through $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
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

    # Don't interfere with a merge/rebase/cherry-pick someone is in the middle of.
    $gitDir = (git rev-parse --git-dir).Trim()
    foreach ($marker in 'MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD') {
        if (Test-Path (Join-Path $gitDir $marker)) { Write-Log "skip: $marker in progress"; exit 1 }
    }

    $changed = git diff --name-only $base $remote

    # Both people work on main. Uncommitted edits are stashed and restored, but
    # only when GitHub didn't touch the same files - otherwise restoring them
    # would leave conflict markers in a file someone has open.
    $dirty = @(git diff --name-only HEAD)
    $overlap = @($dirty | Where-Object { $changed -contains $_ })
    if ($overlap.Count) {
        Write-Log ("skip: uncommitted edits in {0} also changed on GitHub - commit, then git pull --rebase" -f ($overlap -join ', '))
        exit 1
    }
    if ($dirty.Count) {
        git stash push --quiet -m auto-pull 2>$null
        if ($LASTEXITCODE -ne 0) { Write-Log 'stash failed'; exit 1 }
    }

    # Replay unpushed local commits on top of GitHub; on conflict, undo.
    git rebase --quiet "origin/$branch" 2>$null
    $rebaseOk = $LASTEXITCODE -eq 0
    if (-not $rebaseOk) { git rebase --abort 2>$null }
    if ($dirty.Count) {
        git stash pop --quiet 2>$null
        if ($LASTEXITCODE -ne 0) { Write-Log 'warning: could not restore uncommitted edits - they are in git stash, run: git stash pop' }
    }
    if (-not $rebaseOk) {
        Write-Log "skip: local commits conflict with origin/$branch - resolve by hand (git pull --rebase)"
        exit 1
    }

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
