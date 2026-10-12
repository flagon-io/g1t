# Installs the g1t CLI on Windows:
#
#   irm https://g1t.sh/install.ps1 | iex
#
# It downloads the build from g1t.sh/downloads/cli, checks it against the
# release's SHA256SUMS, puts it in %LOCALAPPDATA%\g1t\bin, and adds that to
# your PATH.
#
#   G1T_INSTALL_DIR  where to put g1t.exe
#   G1T_VERSION      a version to install, such as 0.2.0 (default: the latest)
#
# Docs: https://docs.g1t.sh/guides/cli/
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$base = if ($env:G1T_DOWNLOAD_URL) { $env:G1T_DOWNLOAD_URL } else { 'https://g1t.sh/downloads/cli' }
$version = if ($env:G1T_VERSION) { $env:G1T_VERSION.TrimStart('v') } else { 'latest' }
$dir = if ($env:G1T_INSTALL_DIR) { $env:G1T_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'g1t\bin' }

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne 'AMD64' -and $arch -ne 'ARM64') { throw "g1t install: there is no build for $arch." }
# Windows on ARM runs the x64 build.
$file = 'g1t-windows-x64.exe'

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('g1t-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    Write-Host "Downloading g1t ($version, windows x64)..."
    $exe = Join-Path $tmp 'g1t.exe'
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$version/$file" -OutFile $exe
    $sumsFile = Join-Path $tmp 'SHA256SUMS'
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$version/SHA256SUMS" -OutFile $sumsFile
    $want = Get-Content $sumsFile |
        Where-Object { ($_ -split '\s+')[1] -eq $file } |
        ForEach-Object { ($_ -split '\s+')[0] } |
        Select-Object -First 1
    if (-not $want) { throw "g1t install: SHA256SUMS names no $file." }
    $have = (Get-FileHash -Algorithm SHA256 -Path $exe).Hash.ToLower()
    if ($have -ne $want.ToLower()) { throw "g1t install: the download's SHA-256 is $have, not $want. Nothing was installed." }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Move-Item -Force -Path $exe -Destination (Join-Path $dir 'g1t.exe')
}
finally {
    Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $dir)) {
    $joined = if ($userPath) { "$userPath;$dir" } else { $dir }
    [Environment]::SetEnvironmentVariable('Path', $joined, 'User')
    $env:Path = "$env:Path;$dir"
    Write-Host "Added $dir to your PATH; terminals opened from now on have it."
}
$installed = & (Join-Path $dir 'g1t.exe') --version
Write-Host "Installed $installed to $dir\g1t.exe"
Write-Host 'Next: g1t auth login'
