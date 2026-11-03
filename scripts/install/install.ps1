# Installs floti in this user's own folder, %LOCALAPPDATA%\Programs\Floti\bin,
# with no admin rights: Install-Floti <version> <file name> <sha256> <URL | ->.
# With a URL it downloads <URL>/<file name>; with - it reads the file from
# standard input. The file is written beside floti.exe under a temporary
# name, checked against <sha256>, and only then moved into place, so a floti
# that was there keeps working when anything fails. It prints the installed
# path on one line; a failure is one line on standard error starting
# "floti install: ", and status 1. The desktop sends it with
# -EncodedCommand, which cmd caps near 8000 characters: keep it short.
# One function, called on its last line: a script cut off runs nothing.
function Install-Floti {
  param([string]$Version, [string]$File, [string]$Sha256, [string]$From)
  $ErrorActionPreference = 'Stop'
  # Progress on a redirected stream is written as CLIXML, burying the last line.
  $ProgressPreference = 'SilentlyContinue'
  $tmp = $null
  try {
    if (-not ($Version -and $File -and $Sha256 -and $From)) { throw 'usage: Install-Floti <version> <file name> <sha256> <URL | ->' }
    $dir = Join-Path $env:LOCALAPPDATA 'Programs\Floti\bin'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $tmp = Join-Path $dir ".floti-$Version.$PID.exe"
    if ($From -eq '-') {
      $in = [Console]::OpenStandardInput()
      $out = [IO.File]::Create($tmp)
      try { $in.CopyTo($out) } finally { $out.Close() }
    } else {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      (New-Object Net.WebClient).DownloadFile("$From/$File", $tmp)
    }
    # .NET, not Get-FileHash: a script function that Windows PowerShell cannot
    # load when it inherits PowerShell 7's PSModulePath (an ssh shell of pwsh).
    $s = [IO.File]::OpenRead($tmp)
    try { $got = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($s)).Replace('-', '').ToLowerInvariant() } finally { $s.Close() }
    if ($got -ne $Sha256) { throw "$File did not match its SHA-256, so it was not installed." }
    $dest = Join-Path $dir 'floti.exe'
    $old = Join-Path $dir 'floti.old.exe'
    # A running floti.exe can be renamed but not replaced.
    if (Test-Path -LiteralPath $dest) { Move-Item -Force -LiteralPath $dest -Destination $old }
    try { Move-Item -LiteralPath $tmp -Destination $dest }
    catch { if (Test-Path -LiteralPath $old) { Move-Item -Force -LiteralPath $old -Destination $dest }; throw }
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $old
    [Console]::Out.WriteLine($dest)
    exit 0
  } catch {
    if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $tmp }
    [Console]::Error.WriteLine("floti install: $($_.Exception.Message)")
    exit 1
  }
}
Install-Floti @args
