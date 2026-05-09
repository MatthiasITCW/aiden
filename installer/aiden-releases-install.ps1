<#
.SYNOPSIS
  Aiden installer for Windows — Phase 30.2 (v4.0.2).

.DESCRIPTION
  Detects existing installations, verifies Node.js 18+ is on PATH,
  installs aiden-runtime globally via npm with honest progress
  feedback, and verifies the `aiden` launcher is available.

  Five steps:
    [0/4] Check for existing installation (offer fresh / update / cancel)
    [1/4] Verify Node.js + npm
    [2/4] npm install -g aiden-runtime (with Write-Progress feedback)
    [3/4] Verify the `aiden` command resolves on PATH
    [4/4] Quick-start prompt (launch now / later)

  The denominator stays at 4 because [0/4] is a precondition gate, not
  a workflow step — most users skip it (no prior install) and the
  remaining four steps are the actual install.

.EXAMPLE
  iwr https://aiden.taracod.com/install.ps1 -useb | iex
  # -- or equivalently --
  Invoke-WebRequest https://aiden.taracod.com/install.ps1 -UseBasicParsing | Invoke-Expression
#>

$ErrorActionPreference = "Stop"

# ── Banner ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "     █████╗ ██╗██████╗ ███████╗███╗   ██╗" -ForegroundColor Yellow
Write-Host "    ██╔══██╗██║██╔══██╗██╔════╝████╗  ██║" -ForegroundColor Yellow
Write-Host "    ███████║██║██║  ██║█████╗  ██╔██╗ ██║" -ForegroundColor Yellow
Write-Host "    ██╔══██║██║██║  ██║██╔══╝  ██║╚██╗██║" -ForegroundColor Yellow
Write-Host "    ██║  ██║██║██████╔╝███████╗██║ ╚████║" -ForegroundColor Yellow
Write-Host "    ╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═══╝" -ForegroundColor Yellow
Write-Host ""
Write-Host "    Local-first AI engine for Windows" -ForegroundColor DarkGray
Write-Host "    aiden.taracod.com" -ForegroundColor DarkGray
Write-Host ""

$Package = "aiden-runtime"

# ── Helpers ───────────────────────────────────────────────────────────────────
function Test-IsInteractive {
  # Detect non-interactive (CI, piped scripts, IDE-spawned shells) so the
  # installer doesn't crash on Read-Host. Defaults to "update only" when
  # we can't prompt, since that's the safer non-destructive path.
  try {
    if ([Environment]::UserInteractive -eq $false) { return $false }
    if ($Host.Name -notmatch "ConsoleHost") { return $false }
  } catch { return $false }
  return $true
}

# ── [0/4] Detect existing installation ───────────────────────────────────────
Write-Host "  [0/4] " -ForegroundColor Yellow -NoNewline
Write-Host "Checking for existing installation..."

$existingFindings = @()
$existingPaths    = @()

# Phase 30.2: cover the two locations that have ever held Aiden state on
# Windows. v4 writes to LOCALAPPDATA; APPDATA can hold legacy state from
# earlier builds or third-party tooling that wrote to the wrong place.
$candidatePaths = @(
  @{ Path = "$env:APPDATA\aiden";       Label = "config" },
  @{ Path = "$env:LOCALAPPDATA\aiden";  Label = "config" }
)
foreach ($c in $candidatePaths) {
  if (Test-Path $c.Path) {
    $existingFindings += "    - $($c.Path)    ($($c.Label))"
    $existingPaths    += $c.Path
  }
}

# Probe npm. Relax ErrorActionPreference so a stderr write or exit code
# from `npm list` doesn't terminate the script — we only care about the
# captured output.
$npmInstalled    = $false
$existingVersion = $null
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  # `npm list -g <pkg> --depth=0` exits 1 when the package is missing.
  # Capture both streams; the parsed match below decides truth.
  $npmListOutput = & npm list -g $Package --depth=0 2>&1 | Out-String
  if ($npmListOutput -match "$([regex]::Escape($Package))@([\d\w\.\-]+)") {
    $existingVersion = $Matches[1]
    $npmInstalled    = $true
    $existingFindings += "    - npm: $Package@$existingVersion    (package)"
  }
} catch {
  # npm not on PATH yet — that's fine, [1/4] will catch it.
} finally {
  $ErrorActionPreference = $prevEAP
}

if ($existingFindings.Count -gt 0) {
  Write-Host ""
  Write-Host "         Existing Aiden installation detected:" -ForegroundColor Yellow
  foreach ($f in $existingFindings) { Write-Host $f }
  Write-Host ""
  Write-Host "         How would you like to proceed?"
  Write-Host "           [1] " -ForegroundColor Yellow -NoNewline
  Write-Host "Fresh install   — wipe config, reinstall package"
  Write-Host "           [2] " -ForegroundColor Yellow -NoNewline
  Write-Host "Update only     — keep config, upgrade package"
  Write-Host "           [3] " -ForegroundColor Yellow -NoNewline
  Write-Host "Cancel"
  Write-Host ""

  $choice = ""
  if (Test-IsInteractive) {
    try {
      $choice = Read-Host "         Enter choice (1/2/3)"
    } catch {
      $choice = ""
    }
  } else {
    Write-Host "         (non-interactive session — defaulting to 'update only')" -ForegroundColor DarkGray
    $choice = "2"
  }

  switch ($choice) {
    '1' {
      Write-Host ""
      Write-Host "         Wiping existing config..." -ForegroundColor Yellow
      foreach ($p in $existingPaths) {
        try {
          Remove-Item $p -Recurse -Force -ErrorAction Stop
          Write-Host "           - removed $p" -ForegroundColor DarkGray
        } catch {
          Write-Host "           - could not remove $p ($_)" -ForegroundColor Red
        }
      }
      if ($npmInstalled) {
        Write-Host "         Uninstalling existing $Package@$existingVersion..." -ForegroundColor Yellow
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        & npm uninstall -g $Package 2>&1 | Out-Null
        $ErrorActionPreference = $prevEAP
      }
      Write-Host "         Fresh install ready." -ForegroundColor Green
    }
    '2' {
      Write-Host ""
      Write-Host "         Keeping config. Will upgrade package via npm." -ForegroundColor Green
    }
    '3' {
      Write-Host ""
      Write-Host "         Cancelled. No changes made." -ForegroundColor DarkGray
      Write-Host ""
      exit 0
    }
    default {
      Write-Host ""
      Write-Host "         Unrecognised choice '$choice'. Cancelled." -ForegroundColor Yellow
      Write-Host "         Re-run the installer to try again." -ForegroundColor DarkGray
      Write-Host ""
      exit 0
    }
  }
} else {
  Write-Host "         No prior installation found." -ForegroundColor Green
}
Write-Host ""

# ── [1/4] Verify Node.js 18+ ─────────────────────────────────────────────────
Write-Host "  [1/4] " -ForegroundColor Yellow -NoNewline
Write-Host "Checking Node.js..."

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host ""
  Write-Host "  [FAIL] Node.js is not installed." -ForegroundColor Red
  Write-Host ""
  Write-Host "  Aiden requires Node.js 18 or newer."
  Write-Host "  Install Node.js LTS from:"
  Write-Host "    https://nodejs.org/en/download" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  Or via winget:"
  Write-Host "    winget install OpenJS.NodeJS.LTS" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  After installing, open a NEW PowerShell and re-run this installer."
  exit 1
}

try {
  $nodeVersion = (& node --version) -replace '^v', ''
  $nodeMajor   = [int]($nodeVersion.Split('.')[0])
} catch {
  Write-Host ""
  Write-Host "  [FAIL] Could not read Node.js version: $_" -ForegroundColor Red
  exit 1
}

if ($nodeMajor -lt 18) {
  Write-Host ""
  Write-Host "  [FAIL] Node.js $nodeVersion detected. Aiden requires 18+." -ForegroundColor Red
  Write-Host ""
  Write-Host "  Upgrade Node.js LTS from:"
  Write-Host "    https://nodejs.org/en/download" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  Or via winget:"
  Write-Host "    winget install OpenJS.NodeJS.LTS --force" -ForegroundColor Yellow
  exit 1
}
Write-Host "         Node.js   : v$nodeVersion" -ForegroundColor Green

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
  Write-Host ""
  Write-Host "  [FAIL] npm not found on PATH." -ForegroundColor Red
  Write-Host "  npm ships with Node.js — try reinstalling Node.js LTS."
  exit 1
}
$npmVersion = (& npm --version)
Write-Host "         npm       : v$npmVersion" -ForegroundColor Green
Write-Host ""

# ── [2/4] Install aiden-runtime globally via npm ─────────────────────────────
Write-Host "  [2/4] " -ForegroundColor Yellow -NoNewline
Write-Host "Installing $Package globally (this takes 30-60 seconds)..."
Write-Host ""

# Phase 30.2 — honest progress feedback. npm doesn't expose a percentage,
# so we use Write-Progress with -PercentComplete -1 (indeterminate spinner)
# and update the Status line with each visible npm output line. We also
# parse "added N packages" / "audited N packages" patterns to surface a
# package count when npm gets there. No fake percentages.
#
# We still capture the full output for the failure-classification block
# below (permission / network / generic) so the existing error UX keeps
# working.
$npmOutputLines = New-Object System.Collections.Generic.List[string]
$packageCount   = 0
$lastStatus     = "Starting npm install..."

# stderr from npm (deprecation warnings) becomes a NativeCommandError
# under $ErrorActionPreference = "Stop", so relax it here. We still
# consult $LASTEXITCODE to decide success/failure.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"

Write-Progress -Activity "Installing $Package" -Status $lastStatus -PercentComplete -1
try {
  & npm install -g $Package 2>&1 | ForEach-Object {
    $line = $_.ToString()
    $npmOutputLines.Add($line) | Out-Null
    $trimmed = $line.Trim()
    if (-not $trimmed) { return }

    # Parse known progress patterns. npm 9+ emits final summary lines
    # like "added 234 packages in 12s". Earlier "downloading ..." or
    # "fetching ..." lines come through as raw progress text.
    if ($trimmed -match "^added\s+(\d+)\s+package") {
      $packageCount = [int]$Matches[1]
      $lastStatus   = "$packageCount package(s) installed"
    } elseif ($trimmed -match "^audited\s+(\d+)\s+package") {
      $lastStatus = "Audited $($Matches[1]) package(s)"
    } elseif ($trimmed.Length -gt 70) {
      $lastStatus = $trimmed.Substring(0, 67) + "..."
    } else {
      $lastStatus = $trimmed
    }

    Write-Progress -Activity "Installing $Package" `
                   -Status $lastStatus `
                   -PercentComplete -1
  }
  $npmExitCode = $LASTEXITCODE
} catch {
  $npmExitCode = 1
  $npmOutputLines.Add("[ps-catch] $($_.Exception.Message)") | Out-Null
} finally {
  Write-Progress -Activity "Installing $Package" -Completed
  $ErrorActionPreference = $prevEAP
}

$npmOutput = $npmOutputLines -join "`n"

if ($npmExitCode -ne 0) {
  Write-Host ""
  Write-Host "  [FAIL] npm install exited with code $npmExitCode." -ForegroundColor Red
  Write-Host ""

  if ($npmOutput -match "EACCES|EPERM|access denied|Permission denied") {
    Write-Host "  Permission error detected. Two ways to fix:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Option 1 (recommended) — switch npm to a user-writable prefix:"
    Write-Host "    mkdir `"$env:LOCALAPPDATA\npm`""
    Write-Host "    npm config set prefix `"$env:LOCALAPPDATA\npm`""
    Write-Host "    Add `"$env:LOCALAPPDATA\npm`" to your User PATH."
    Write-Host "    Then re-run this installer."
    Write-Host ""
    Write-Host "  Option 2 — re-run PowerShell as Administrator and try again."
  } elseif ($npmOutput -match "ENOTFOUND|getaddrinfo|ECONNREFUSED|network") {
    Write-Host "  Network error. Check your internet connection." -ForegroundColor Yellow
    Write-Host "  If behind a corporate proxy, configure npm:"
    Write-Host "    npm config set proxy http://your-proxy:port"
    Write-Host "    npm config set https-proxy http://your-proxy:port"
  } else {
    Write-Host "  --- npm output ---" -ForegroundColor DarkGray
    Write-Host $npmOutput -ForegroundColor DarkGray
    Write-Host "  ------------------" -ForegroundColor DarkGray
  }
  exit 1
}

if ($packageCount -gt 0) {
  Write-Host "         Install complete — $packageCount package(s)" -ForegroundColor Green
} else {
  Write-Host "         Install complete" -ForegroundColor Green
}
Write-Host ""

# ── [3/4] Verify aiden is on PATH ────────────────────────────────────────────
Write-Host "  [3/4] " -ForegroundColor Yellow -NoNewline
Write-Host "Verifying installation..."

# Refresh PATH from registry so newly-installed bin is visible in this session.
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "User") + ";" +
            [System.Environment]::GetEnvironmentVariable("PATH", "Machine")

$aidenCmd = Get-Command aiden -ErrorAction SilentlyContinue
$aidenVersion = $null
if ($aidenCmd) {
  try {
    $aidenVersion = (& aiden --version 2>&1 | Out-String).Trim()
  } catch {
    $aidenVersion = $null
  }
}
Write-Host ""

if ($aidenCmd -and $aidenVersion) {
  Write-Host "  ================================================" -ForegroundColor Green
  Write-Host "  SUCCESS  " -ForegroundColor Green -NoNewline
  Write-Host "$Package $aidenVersion installed"
  Write-Host "  ================================================" -ForegroundColor Green
  Write-Host ""
  Write-Host "    Launcher: $($aidenCmd.Source)"
  Write-Host ""

  # ── [4/4] Quick-start prompt ───────────────────────────────────────────────
  Write-Host "  [4/4] " -ForegroundColor Yellow -NoNewline
  Write-Host "How would you like to start Aiden?"
  Write-Host ""
  Write-Host "    [1] " -ForegroundColor Yellow -NoNewline
  Write-Host "Start now      (launch the chat REPL in this terminal)"
  Write-Host "    [2] " -ForegroundColor Yellow -NoNewline
  Write-Host "Later          (I'll start it myself)"
  Write-Host ""

  $startChoice = ""
  if (Test-IsInteractive) {
    try {
      $startChoice = Read-Host "  Enter choice (1/2)"
    } catch {
      $startChoice = ""
    }
  } else {
    Write-Host "  (non-interactive session — choosing 'later')" -ForegroundColor DarkGray
  }

  switch ($startChoice) {
    '1' {
      Write-Host ""
      Write-Host "  Starting Aiden..." -ForegroundColor Green
      & aiden
    }
    default {
      Write-Host ""
      Write-Host "  Ready when you are." -ForegroundColor DarkGray
      Write-Host "  Open a new terminal and type: " -NoNewline
      Write-Host "aiden" -ForegroundColor Yellow
      Write-Host ""
      Write-Host "  Docs:    https://aiden.taracod.com" -ForegroundColor DarkGray
      Write-Host "  GitHub:  https://github.com/taracodlabs/aiden" -ForegroundColor DarkGray
      Write-Host "  Discord: https://discord.gg/gMZ3hUnQTm" -ForegroundColor DarkGray
      Write-Host ""
    }
  }
} else {
  Write-Host "  ================================================"
  Write-Host "  INSTALLED  " -ForegroundColor Yellow -NoNewline
  Write-Host "$Package installed but 'aiden' is not on PATH yet"
  Write-Host "  ================================================"
  Write-Host ""
  Write-Host "  npm installed the package globally, but the bin directory" -ForegroundColor Yellow
  Write-Host "  is not on this session's PATH yet."
  Write-Host ""
  Write-Host "  Open a NEW PowerShell window and type: " -NoNewline
  Write-Host "aiden" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  If 'aiden' is still not found, the npm global bin directory"
  Write-Host "  needs to be added to PATH. Find it with:"
  Write-Host "    npm config get prefix"
  Write-Host "  Add that path (or its parent on Windows) to your User PATH."
  Write-Host ""
  Write-Host "  Docs:    https://aiden.taracod.com" -ForegroundColor DarkGray
  Write-Host "  GitHub:  https://github.com/taracodlabs/aiden" -ForegroundColor DarkGray
  Write-Host "  Discord: https://discord.gg/gMZ3hUnQTm" -ForegroundColor DarkGray
  Write-Host ""
}
