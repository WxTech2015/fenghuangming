param(
  [Parameter(Mandatory=$true)][string]$NssmPath,
  [string]$NodePath,
  [string]$AgentPath,
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [string]$ServiceName = 'QQMusicAgent',
  [string]$TaskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
)
$ErrorActionPreference = 'Stop'
if ($ServiceName -notmatch '^[A-Za-z][A-Za-z0-9_-]{2,60}$') { throw '服务名称格式不正确' }
$taskAdmin = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $taskAdmin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '安装服务需要管理员 PowerShell' }
$taskNssm = (Resolve-Path -LiteralPath $NssmPath).Path
$taskConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
$taskLauncher = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-player.ps1')).Path
$taskSettings = Get-Content -LiteralPath $taskConfig -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $taskSettings.mpvPath -PathType Leaf)) { throw '配置中的 mpvPath 不存在' }
if (-not $taskSettings.dataDir -or -not [IO.Path]::IsPathRooted($taskSettings.dataDir)) { throw '请在配置中填写绝对 dataDir 路径' }
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { throw '该服务已存在，请先卸载或使用其他名称' }
if (Get-ScheduledTask -TaskName "${ServiceName}-Player" -ErrorAction SilentlyContinue) { throw '播放器任务已存在，请先卸载' }
$taskAccount = New-Object System.Security.Principal.NTAccount($TaskUser)
$taskAccount.Translate([System.Security.Principal.SecurityIdentifier]) | Out-Null
if (($NodePath -and $AgentPath) -or (-not $NodePath -and -not $AgentPath)) { throw '请指定 AgentPath 或 NodePath 中的一个' }
if ($AgentPath) {
  $taskSource = (Resolve-Path -LiteralPath $AgentPath).Path
  $taskInstallDirectory = Join-Path $env:ProgramFiles 'FenghuangmingAgent'
  New-Item -ItemType Directory -Force -Path $taskInstallDirectory | Out-Null
  $taskApplication = Join-Path $taskInstallDirectory 'fenghuangming-agent.exe'
  if ($taskSource -ne $taskApplication) { Copy-Item -LiteralPath $taskSource -Destination $taskApplication -Force }
  $taskDirectory = $taskInstallDirectory
  $taskArguments = "--role service --config `"$taskConfig`""
  $taskPlayerArguments = "-AgentPath `"$taskApplication`" -ConfigPath `"$taskConfig`""
} else {
  $taskApplication = (Resolve-Path -LiteralPath $NodePath).Path
  $taskEntry = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../dist/main.js')).Path
  $taskDirectory = Split-Path -Parent $taskEntry
  $taskArguments = "`"$taskEntry`" --role service --config `"$taskConfig`""
  $taskPlayerArguments = "-NodePath `"$taskApplication`" -EntryPath `"$taskEntry`" -ConfigPath `"$taskConfig`""
}
New-Item -ItemType Directory -Force -Path $taskSettings.dataDir | Out-Null
# Restrict the device credential and grant only the service and playback user.
& icacls.exe $taskConfig /inheritance:r /grant:r "${TaskUser}:(R)" '*S-1-5-19:(R)' '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '设置配置文件权限失败' }
& icacls.exe $taskSettings.dataDir /inheritance:r /grant:r "${TaskUser}:(OI)(CI)M" '*S-1-5-19:(OI)(CI)M' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '设置数据目录权限失败' }
function Invoke-AgentNssm([string[]]$NssmArguments) {
  & $taskNssm @NssmArguments
  if ($LASTEXITCODE -ne 0) { throw "NSSM 配置失败（退出码 $LASTEXITCODE）" }
}
$taskServiceCreated = $false
$taskPlayerCreated = $false
try {
Invoke-AgentNssm @('install', $ServiceName, $taskApplication)
$taskServiceCreated = $true
Invoke-AgentNssm @('set', $ServiceName, 'DisplayName', '凤凰鸣播放服务')
Invoke-AgentNssm @('reset', $ServiceName, 'Description')
Invoke-AgentNssm @('set', $ServiceName, 'AppParameters', $taskArguments)
Set-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters" -Name 'AppParameters' -Value $taskArguments -ErrorAction Stop
Invoke-AgentNssm @('set', $ServiceName, 'AppDirectory', $taskDirectory)
Invoke-AgentNssm @('set', $ServiceName, 'ObjectName', 'NT AUTHORITY\LocalService')
Invoke-AgentNssm @('set', $ServiceName, 'Start', 'SERVICE_AUTO_START')
Invoke-AgentNssm @('set', $ServiceName, 'AppStdout', (Join-Path $taskSettings.dataDir 'service.log'))
Invoke-AgentNssm @('set', $ServiceName, 'AppStderr', (Join-Path $taskSettings.dataDir 'service-error.log'))
Invoke-AgentNssm @('set', $ServiceName, 'AppRotateFiles', '1')
Invoke-AgentNssm @('set', $ServiceName, 'AppRotateBytes', '10485760')
Invoke-AgentNssm @('set', $ServiceName, 'AppRestartDelay', '5000')
$taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$taskLauncher`" $taskPlayerArguments" -WorkingDirectory $taskDirectory
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $TaskUser
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Limited
$taskOptions = New-ScheduledTaskSettingsSet -Hidden -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "${ServiceName}-Player" -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskOptions | Out-Null
$taskPlayerCreated = $true
Start-Service -Name $ServiceName
Start-ScheduledTask -TaskName "${ServiceName}-Player"
if ($AgentPath) {
  $taskShell = New-Object -ComObject WScript.Shell
  $taskShortcut = $taskShell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) '凤凰鸣控制台.lnk'))
  $taskShortcut.TargetPath = 'powershell.exe'
  $taskShortcut.Arguments = "-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $PSScriptRoot 'desktop-console.ps1')`" -ConfigPath `"$taskConfig`""
  $taskShortcut.WorkingDirectory = $taskDirectory
  $taskShortcut.WindowStyle = 7
  $taskShortcut.Save()
}
Write-Host '凤凰鸣服务与用户播放器已注册。请在后台确认设备就绪。播放用户需要保持登录。'
} catch {
  if ($taskPlayerCreated) {
    Stop-ScheduledTask -TaskName "${ServiceName}-Player" -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName "${ServiceName}-Player" -Confirm:$false -ErrorAction SilentlyContinue
  }
  if ($taskServiceCreated) {
    Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
    & $taskNssm remove $ServiceName confirm | Out-Null
  }
  throw
}
