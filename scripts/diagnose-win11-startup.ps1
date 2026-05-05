param(
  [switch]$RunBuild
)

$ErrorActionPreference = "Continue"

function Write-Section {
  param([string]$Title)
  "`n===== $Title ====="
}

function Invoke-Logged {
  param(
    [string]$Label,
    [scriptblock]$Command
  )

  Write-Section $Label
  try {
    & $Command 2>&1 | Out-String
  } catch {
    "ERROR: $($_.Exception.Message)"
  }
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportPath = Join-Path $projectRoot "win11-startup-diagnosis-$stamp.txt"

$lines = New-Object System.Collections.Generic.List[string]

function Add-Text {
  param([string]$Text)
  $lines.Add($Text)
}

Set-Location $projectRoot

Add-Text "InFinio Win11 startup diagnosis"
Add-Text "Generated: $(Get-Date -Format o)"
Add-Text "Project root: $projectRoot"

Add-Text (Invoke-Logged "System" {
  Get-ComputerInfo | Select-Object OsName, OsVersion, OsArchitecture, CsTotalPhysicalMemory
  Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory, FreeVirtualMemory
  Get-PSDrive -PSProvider FileSystem | Select-Object Name, Root, Free, Used
})

Add-Text (Invoke-Logged "Node and npm" {
  "node: $(node -v)"
  "npm: $(npm -v)"
  "where node:"
  where.exe node
  "where npm:"
  where.exe npm
})

Add-Text (Invoke-Logged "Project files" {
  "package.json exists: $(Test-Path package.json)"
  "package-lock.json exists: $(Test-Path package-lock.json)"
  "node_modules exists: $(Test-Path node_modules)"
  "dist exists: $(Test-Path dist)"
  "electron/main.cjs exists: $(Test-Path electron/main.cjs)"
  "electron/preload.cjs exists: $(Test-Path electron/preload.cjs)"
  "config/builtin-api.json exists: $(Test-Path config/builtin-api.json)"
  "vendor/ffmpeg/ffmpeg.exe exists: $(Test-Path vendor/ffmpeg/ffmpeg.exe)"
  "vendor/ffmpeg/ffprobe.exe exists: $(Test-Path vendor/ffmpeg/ffprobe.exe)"
  "vendor/ffmpeg/ggml-small-q5_1.bin exists: $(Test-Path vendor/ffmpeg/ggml-small-q5_1.bin)"
})

Add-Text (Invoke-Logged "Directory sizes" {
  foreach ($dir in @("node_modules", "files", "vendor", "dist", "src", "electron", "config", "public")) {
    if (Test-Path $dir) {
      $sum = (Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
      [pscustomobject]@{ Dir = $dir; MB = [math]::Round(($sum / 1MB), 2) }
    }
  }
})

Add-Text (Invoke-Logged "Port 8080" {
  Get-NetTCPConnection -LocalPort 8080 -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, State, OwningProcess
  $pids = Get-NetTCPConnection -LocalPort 8080 -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($id in $pids) {
    Get-Process -Id $id -ErrorAction SilentlyContinue |
      Select-Object Id, ProcessName, Path
  }
})

Add-Text (Invoke-Logged "Electron logs" {
  $startup = Join-Path $env:TEMP "infinio-startup.log"
  "startup log: $startup"
  if (Test-Path $startup) {
    Get-Content $startup -Tail 120
  } else {
    "startup log not found"
  }

  $crash = Join-Path $env:APPDATA "InFinio\crash-log.json"
  "crash log: $crash"
  if (Test-Path $crash) {
    Get-Content $crash -Tail 120
  } else {
    "crash log not found"
  }
})

Add-Text (Invoke-Logged "npm dependency check" {
  if (Test-Path node_modules) {
    npm ls --depth=0
  } else {
    "node_modules is missing. Run: npm ci"
  }
})

Add-Text (Invoke-Logged "Electron compile check" {
  if (Test-Path node_modules) {
    node electron/build.mjs
  } else {
    "Skipped because node_modules is missing."
  }
})

if ($RunBuild) {
  Add-Text (Invoke-Logged "Vite production build" {
    if (Test-Path node_modules) {
      npm run build
    } else {
      "Skipped because node_modules is missing."
    }
  })
} else {
  Add-Text "Skipped Vite production build. Re-run with: powershell -ExecutionPolicy Bypass -File scripts/diagnose-win11-startup.ps1 -RunBuild"
}

$lines | Set-Content -Path $reportPath -Encoding UTF8

Write-Host "Diagnosis report written to:"
Write-Host $reportPath
