param([Parameter(Mandatory=$true)][string]$NssmPath, [string]$ServiceName = 'QQMusicAgent')
$ErrorActionPreference = 'Stop'
if ($ServiceName -notmatch '^[A-Za-z][A-Za-z0-9_-]{2,60}$') { throw '服务名称格式不正确' }
$taskNssm = (Resolve-Path -LiteralPath $NssmPath).Path
$taskPlayerName = "${ServiceName}-Player"
if (Get-ScheduledTask -TaskName $taskPlayerName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $taskPlayerName; Unregister-ScheduledTask -TaskName $taskPlayerName -Confirm:$false }
$taskProcesses=Get-CimInstance Win32_Process -Filter "Name='fenghuangming-agent.exe' OR Name='mpv.exe'"
$taskWorkers=@($taskProcesses | Where-Object { $_.ExecutablePath -eq (Join-Path $env:ProgramFiles 'FenghuangmingAgent\fenghuangming-agent.exe') -and $_.CommandLine -match '--role\s+worker' })
foreach($taskWorker in $taskWorkers) {
  $taskProcesses | Where-Object { $_.Name -eq 'mpv.exe' -and $_.ParentProcessId -eq $taskWorker.ProcessId } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
  Stop-Process -Id $taskWorker.ProcessId -ErrorAction SilentlyContinue
}
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue; & $taskNssm remove $ServiceName confirm; if ($LASTEXITCODE -ne 0) { throw 'NSSM 卸载失败' } }
Write-Host '已移除服务与登录任务，设备配置和缓存仍保留。'
