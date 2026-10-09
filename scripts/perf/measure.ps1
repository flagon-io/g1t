<#
.SYNOPSIS
  Times g1t.sh pages from this machine: time to first byte, where the Worker
  ran (cf-placement) and where the time went (Server-Timing). Run it before
  and after a change and compare. docs/PERFORMANCE.md explains the columns.

.EXAMPLE
  # Signed out
  powershell -File scripts/perf/measure.ps1

.EXAMPLE
  # Signed in: copy the value of your g1t_session cookie from the browser
  # (DevTools > Application > Cookies > https://g1t.sh) into G1T_SESSION.
  # The script never prints it.
  $env:G1T_SESSION = "<64 hex characters>"
  powershell -File scripts/perf/measure.ps1 -Runs 7 -Out before.csv

.EXAMPLE
  # Signed in with an access token that has "Use the website as you" on:
  # G1T_TOKEN_FILE names the file holding it. The script never prints it.
  $env:G1T_TOKEN_FILE = "$HOME\.config\g1t\website-token"
  powershell -File scripts/perf/measure.ps1 -Runs 7

.EXAMPLE
  # As a browser sees it: React Router streams to browsers and renders the
  # whole page first for anything it takes for a crawler, which curl's own
  # user agent is. Compare the two to see what streaming saves.
  powershell -File scripts/perf/measure.ps1 -BrowserUA

.NOTES
  Uses curl.exe (Windows' own). Git Bash's curl fails here with exit 43.
#>
param(
  [string]$Base = "https://g1t.sh",
  [string]$Repo = "flagon-io/g1t",
  [int]$Pull = 1,
  [int]$Issue = 2,
  [int]$Runs = 5,
  [string[]]$Paths = @(),
  [string]$Out = "",
  # Send a desktop Chrome user agent: streamed pages, as people get them.
  # Without it the requests look like a crawler's and wait for the whole page.
  [switch]$BrowserUA
)

$ErrorActionPreference = "Stop"

# Pages people open most, and the data request a click inside the app makes
# for the same page (React Router's `.data`, with only the page's own
# loader, as an in-app navigation sends it).
if ($Paths.Count -eq 0) {
  $Paths = @(
    "/",
    "/explore",
    "/$Repo",
    "/$Repo/pulls",
    "/$Repo/issues",
    "/$Repo/pull/$Pull",
    "/$Repo/issues/$Issue",
    "/$Repo/pull/$Pull.data?_routes=routes%2Frepo%2Fpull",
    "/$Repo/pulls.data?_routes=routes%2Frepo%2Fpulls",
    "/pricing"
  )
}

$signedIn = [bool]$env:G1T_SESSION
$cookieArgs = @()
if ($signedIn) { $cookieArgs = @("-H", "Cookie: g1t_session=$($env:G1T_SESSION)") }
# Signed in with an access token that may use the website: G1T_TOKEN_FILE
# names the file holding it. curl reads the header from a temporary file,
# so the token is never on a command line or printed. It wins over
# G1T_SESSION, as on the site.
$tokenHeaderFile = $null
if ($env:G1T_TOKEN_FILE) {
  if (-not (Test-Path -LiteralPath $env:G1T_TOKEN_FILE -PathType Leaf)) { throw "G1T_TOKEN_FILE does not name a file." }
  $tokenHeaderFile = [System.IO.Path]::GetTempFileName()
  $header = "Authorization: Bearer " + (Get-Content -Raw -LiteralPath $env:G1T_TOKEN_FILE).Trim()
  [System.IO.File]::WriteAllText($tokenHeaderFile, $header)
  Remove-Variable header
  $cookieArgs = @("-H", "@$tokenHeaderFile")
  $signedIn = $true
}
$agentArgs = @()
if ($BrowserUA) {
  $agentArgs = @("-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
}

function Measure-Once([string]$url) {
  $headerFile = [System.IO.Path]::GetTempFileName()
  try {
    $timing = & curl.exe -s -o NUL -D $headerFile -H "cache-control: no-cache" @cookieArgs @agentArgs `
      -w "%{http_code} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total}" $url
    $parts = $timing.Trim().Split(" ")
    $headers = Get-Content $headerFile
    $serverTiming = ($headers | Where-Object { $_ -match "^server-timing:" } | ForEach-Object { ($_ -split ":", 2)[1].Trim() }) -join ", "
    $cookie = [bool]($headers | Where-Object { $_ -match "^set-cookie:\s*g1t_d1=" })
    $placement = ($headers | Where-Object { $_ -match "^cf-placement:" } | ForEach-Object { ($_ -split ":", 2)[1].Trim() }) -join ""
    $ray = ($headers | Where-Object { $_ -match "^cf-ray:" } | ForEach-Object { (($_ -split ":", 2)[1].Trim() -split "-")[-1] }) -join ""
    [pscustomobject]@{
      Status    = [int]$parts[0]
      # From the TLS handshake's end to the first byte: the server's share.
      ServerMs  = [math]::Round(([double]$parts[3] - [double]$parts[2]) * 1000)
      TtfbMs    = [math]::Round([double]$parts[3] * 1000)
      TotalMs   = [math]::Round([double]$parts[4] * 1000)
      Placement = $placement
      Edge      = $ray
      Timing    = $serverTiming
      # A read-only page should never set g1t_d1: it would then skip the
      # public cache and send the person's next 30 s of reads to the primary.
      SetsD1    = [bool]$cookie
    }
  } finally {
    Remove-Item $headerFile -ErrorAction SilentlyContinue
  }
}

function Percentile([double[]]$values, [double]$p) {
  $sorted = $values | Sort-Object
  $index = [math]::Min($sorted.Count - 1, [math]::Floor($p * $sorted.Count))
  return $sorted[$index]
}

# The Server-Timing entries worth a column: total, and the slowest three.
function Summarize-Timing([string]$header) {
  if (-not $header) { return "" }
  $entries = $header -split ",\s*(?=[A-Za-z0-9_.-]+;)" | ForEach-Object {
    $name = ($_ -split ";")[0]
    $dur = if ($_ -match "dur=([0-9.]+)") { [double]$Matches[1] } else { $null }
    [pscustomobject]@{ Name = $name; Dur = $dur }
  }
  $total = $entries | Where-Object { $_.Name -eq "total" } | Select-Object -First 1
  $rest = $entries | Where-Object { $_.Name -ne "total" -and $_.Dur -ne $null } | Sort-Object Dur -Descending | Select-Object -First 4
  $shown = @()
  if ($total) { $shown += "total=$($total.Dur)" }
  $shown += $rest | ForEach-Object { "$($_.Name)=$($_.Dur)" }
  return ($shown -join " ")
}

Write-Host "Measuring $Base, $Runs runs each, $(if ($tokenHeaderFile) { 'signed in with a token' } elseif ($signedIn) { 'signed in' } else { 'signed out' }), $(if ($BrowserUA) { 'as a browser (streamed)' } else { 'as curl (a crawler: whole page first)' })."
try {
$rows = foreach ($path in $Paths) {
  $url = "$Base$path"
  $null = Measure-Once $url   # warm the connection and the isolate
  $samples = 1..$Runs | ForEach-Object { Measure-Once $url }
  $server = $samples | ForEach-Object { [double]$_.ServerMs }
  $last = $samples[-1]
  [pscustomobject]@{
    Path         = $path
    Status       = $last.Status
    "p50 ms"     = Percentile $server 0.5
    "p90 ms"     = Percentile $server 0.9
    "TTFB p50"   = Percentile ($samples | ForEach-Object { [double]$_.TtfbMs }) 0.5
    Placement    = $last.Placement
    Edge         = $last.Edge
    "Sets g1t_d1" = $last.SetsD1
    "Server-Timing (last run)" = Summarize-Timing $last.Timing
  }
}
} finally {
  if ($tokenHeaderFile) { Remove-Item -LiteralPath $tokenHeaderFile -ErrorAction SilentlyContinue }
}

$rows | Format-Table -AutoSize -Wrap
if ($Out) {
  $rows | Export-Csv -NoTypeInformation -Path $Out
  Write-Host "Saved to $Out"
}
Write-Host "p50/p90 ms: from the end of the TLS handshake to the first byte (the server's share). TTFB includes connecting."
