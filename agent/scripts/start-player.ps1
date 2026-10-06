param([string]$NodePath, [string]$EntryPath, [string]$AgentPath, [Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$taskConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
if ($AgentPath) {
  $taskApplication = (Resolve-Path -LiteralPath $AgentPath).Path
  $taskArguments = "--role worker --config `"$taskConfig`""
  $taskDirectory = Split-Path -Parent $taskApplication
} else {
  if (-not $NodePath -or -not $EntryPath) { throw '缺少播放器启动参数' }
  $taskApplication = (Resolve-Path -LiteralPath $NodePath).Path
  $taskEntry = (Resolve-Path -LiteralPath $EntryPath).Path
  $taskArguments = "`"$taskEntry`" --role worker --config `"$taskConfig`""
  $taskDirectory = Split-Path -Parent $taskEntry
}
$taskSettings = Get-Content -LiteralPath $taskConfig -Raw -Encoding UTF8 | ConvertFrom-Json
$taskPlayerProcess = Start-Process -FilePath $taskApplication -ArgumentList $taskArguments -WorkingDirectory $taskDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskSettings.dataDir 'player.log') -RedirectStandardError (Join-Path $taskSettings.dataDir 'player-error.log') -PassThru -Wait
exit $taskPlayerProcess.ExitCode
