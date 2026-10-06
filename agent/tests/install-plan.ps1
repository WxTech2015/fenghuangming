param([Parameter(Mandatory=$true)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
$taskTokens = $null
$taskErrors = $null
$taskAst = [System.Management.Automation.Language.Parser]::ParseFile($InstallerPath, [ref]$taskTokens, [ref]$taskErrors)
if ($taskErrors.Count) { throw '打包后的安装脚本语法错误' }
$taskHelper = $taskAst.Find({ param($taskNode) $taskNode -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $taskNode.Name -eq 'Invoke-AgentNssm' }, $true)
$taskFlow = $taskAst.Find({ param($taskNode) $taskNode -is [System.Management.Automation.Language.TryStatementAst] }, $true)
if (-not $taskHelper -or -not $taskFlow) { throw '缺少安装事务' }

# Execute only the registration transaction with mock commands, never OS services/tasks.
$taskCalls = New-Object 'System.Collections.Generic.List[object]'
$taskStopped = $false
function Invoke-MockNssm {
  $taskCalls.Add(@($args))
  $global:LASTEXITCODE = 0
  if ($args[0] -eq 'set' -and $args[2] -eq 'Start') { $global:LASTEXITCODE = 99 }
}
function Stop-Service { param($Name, $ErrorAction) $script:taskStopped = $true }
function Stop-ScheduledTask { throw '尚未创建播放器任务' }
function Unregister-ScheduledTask { throw '尚未创建播放器任务' }
function New-ScheduledTaskAction { throw 'NSSM 失败后不应继续注册任务' }
function New-ScheduledTaskTrigger { throw 'NSSM 失败后不应继续注册任务' }
function New-ScheduledTaskPrincipal { throw 'NSSM 失败后不应继续注册任务' }
function New-ScheduledTaskSettingsSet { throw 'NSSM 失败后不应继续注册任务' }
function Register-ScheduledTask { throw 'NSSM 失败后不应继续注册任务' }
function Start-ScheduledTask { throw 'NSSM 失败后不应启动任务' }
function Start-Service { throw 'NSSM 失败后不应启动服务' }
$taskRegistryArguments = $null
function Set-ItemProperty { param($LiteralPath, $Name, $Value, $ErrorAction) if ($Name -ne 'AppParameters') { throw '非预期注册表修改' }; $script:taskRegistryArguments = $Value }
$taskNssm = 'Invoke-MockNssm'
$ServiceName = 'QQMusicAgent-Package-Test'
$taskApplication = 'C:\Program Files\FenghuangmingAgent\fenghuangming-agent.exe'
$taskDirectory = 'C:\Program Files\FenghuangmingAgent'
$taskConfig = 'C:\测试播放 with spaces\agent.config.json'
$taskArguments = "--role service --config `"$taskConfig`""
$taskServiceCreated = $false
$taskPlayerCreated = $false
Invoke-Expression $taskHelper.Extent.Text
$taskExpectedFailure = $false
try { Invoke-Expression $taskFlow.Extent.Text }
catch { if ($_.Exception.Message -notmatch 'NSSM 配置失败') { throw }; $taskExpectedFailure = $true }
if (-not $taskExpectedFailure -or -not $taskStopped) { throw '服务配置失败未回滚' }
$taskInstall = @($taskCalls | Where-Object { $_[0] -eq 'install' })
$taskParameter = @($taskCalls | Where-Object { $_[2] -eq 'AppParameters' })
$taskRemoval = @($taskCalls | Where-Object { $_[0] -eq 'remove' })
if ($taskInstall.Count -ne 1 -or $taskInstall[0][2] -ne $taskApplication) { throw '注册的程序路径错误' }
if ($taskParameter.Count -ne 1 -or $taskParameter[0][3] -ne $taskArguments) { throw '带中文和空格的配置路径丢失' }
if ($taskRegistryArguments -ne $taskArguments) { throw '最终服务参数未保留配置路径引号' }
if ($taskRemoval.Count -ne 1 -or $taskRemoval[0][1] -ne $ServiceName) { throw '失败后未移除本次创建的服务' }
'PASS Windows 服务参数和安装失败回滚（模拟系统调用）'
