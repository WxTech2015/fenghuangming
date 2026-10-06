param([Parameter(Mandatory=$true)][string]$ConfigPath, [string]$PreviewPath, [string]$DataDir)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http
[System.Windows.Forms.Application]::EnableVisualStyles()
$taskConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$taskSettings = Get-Content -LiteralPath $taskConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$taskDirectory = if($DataDir){[IO.Path]::GetFullPath($DataDir)}elseif($taskSettings.dataDir){[IO.Path]::GetFullPath($taskSettings.dataDir)}else{Join-Path $env:ProgramData 'QQMusicAgent'}
$taskSecret = $taskSettings.ipcSecret
if (-not $taskSecret) { $taskHasher=[Security.Cryptography.SHA256]::Create(); $taskSecret=([BitConverter]::ToString($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes("local-ipc:$($taskSettings.token)")))).Replace('-','').ToLowerInvariant(); $taskHasher.Dispose() }
$taskClient = New-Object System.Net.Http.HttpClient
$taskClient.Timeout = [TimeSpan]::FromSeconds(2)
$taskClient.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer',$taskSecret)
$taskPending = $null; $taskLogPending = $null; $taskTicks = 0
function Local-Url([string]$Path) { $info=Get-Content -LiteralPath (Join-Path $taskDirectory 'control-info.json') -Raw | ConvertFrom-Json; if ($info.port -lt 1 -or $info.port -gt 65535) { throw '本机服务端口无效' }; return "http://127.0.0.1:$($info.port)$Path" }
function Send-Control([string]$Path, $Body) { $content=New-Object System.Net.Http.StringContent(($Body | ConvertTo-Json -Compress),[Text.Encoding]::UTF8,'application/json'); try { $response=$taskClient.PostAsync((Local-Url $Path),$content).GetAwaiter().GetResult(); $text=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult(); if (-not $response.IsSuccessStatusCode) { $errorBody=$text | ConvertFrom-Json; throw $errorBody.error }; $response.Dispose(); } finally { $content.Dispose() } }
function New-Label([string]$Text,[int]$X,[int]$Y,[int]$Width,[int]$Height=26,[int]$Size=10) { $label=New-Object Windows.Forms.Label; $label.Text=$Text; $label.Location=New-Object Drawing.Point($X,$Y); $label.Size=New-Object Drawing.Size($Width,$Height); $label.Font=New-Object Drawing.Font('Microsoft YaHei UI',$Size); $label.ForeColor=[Drawing.Color]::FromArgb(50,60,81); $label.BackColor=[Drawing.Color]::Transparent; $label.AutoEllipsis=$true; return $label }
function New-Button([string]$Text,[int]$X,[int]$Y,[int]$Width) { $button=New-Object Windows.Forms.Button; $button.Text=$Text; $button.Location=New-Object Drawing.Point($X,$Y); $button.Size=New-Object Drawing.Size($Width,38); $button.FlatStyle='Flat'; $button.FlatAppearance.BorderSize=0; $button.BackColor=[Drawing.Color]::FromArgb(237,234,250); $button.ForeColor=[Drawing.Color]::FromArgb(99,79,171); $button.Font=New-Object Drawing.Font('Microsoft YaHei UI',10); $button.Cursor=[Windows.Forms.Cursors]::Hand; return $button }
function Time-Text($Value) { $valueInt=[int][Math]::Floor([Math]::Max(0,[double]$Value)); return ('{0:D2}:{1:D2}' -f [int][Math]::Floor($valueInt/60),($valueInt % 60)) }
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition 'using System;using System.Drawing;using System.Drawing.Drawing2D;using System.Windows.Forms;public class FenghuangCard:Panel{public Color Fill=Color.White;public FenghuangCard(){DoubleBuffered=true;}protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;using(var p=new GraphicsPath()){int r=18,w=Width-1,h=Height-1;p.AddArc(0,0,r,r,180,90);p.AddArc(w-r,0,r,r,270,90);p.AddArc(w-r,h-r,r,r,0,90);p.AddArc(0,h-r,r,r,90,90);p.CloseFigure();using(var b=new SolidBrush(Fill))e.Graphics.FillPath(b,p);using(var pen=new Pen(Color.FromArgb(228,232,241)))e.Graphics.DrawPath(pen,p);}}}'
function New-Card([int]$X,[int]$Y,[int]$W,[int]$H) { $card=New-Object FenghuangCard; $card.Location=New-Object Drawing.Point($X,$Y); $card.Size=New-Object Drawing.Size($W,$H); $card.BackColor=[Drawing.Color]::FromArgb(243,245,250); return $card }
function Set-Indicator($Label,[string]$Text,[string]$Tone) { $Label.Text=$Text; switch($Tone){ 'good' {$Label.ForeColor=[Drawing.Color]::FromArgb(38,128,88);$Label.BackColor=[Drawing.Color]::FromArgb(232,246,238)} 'warn' {$Label.ForeColor=[Drawing.Color]::FromArgb(165,111,31);$Label.BackColor=[Drawing.Color]::FromArgb(255,245,223)} 'bad' {$Label.ForeColor=[Drawing.Color]::FromArgb(185,58,72);$Label.BackColor=[Drawing.Color]::FromArgb(254,235,238)} default {$Label.ForeColor=[Drawing.Color]::FromArgb(114,122,142);$Label.BackColor=[Drawing.Color]::FromArgb(238,241,247)} } }
$taskForm=New-Object Windows.Forms.Form
$taskWindowHeight=[int][Math]::Min(872,[Math]::Max(580,[Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Height-80)); $taskCompact=872-$taskWindowHeight
$taskForm.Text='凤凰鸣 · 播放控制台'; $taskForm.ClientSize=New-Object Drawing.Size(1040,$taskWindowHeight)
$taskForm.MinimumSize=$taskForm.Size; $taskForm.MaximumSize=$taskForm.Size; $taskForm.StartPosition='CenterScreen'; $taskForm.BackColor=[Drawing.Color]::FromArgb(243,245,250)
$taskHeader=New-Object Windows.Forms.Panel; $taskHeader.Location=New-Object Drawing.Point(0,0);$taskHeader.Size=New-Object Drawing.Size(1040,94);$taskHeader.BackColor=[Drawing.Color]::FromArgb(28,36,59);$taskForm.Controls.Add($taskHeader)
$taskLogo=New-Label '♫' 28 20 48 48 25; $taskLogo.ForeColor=[Drawing.Color]::FromArgb(218,199,255);$taskLogo.TextAlign='MiddleCenter';$taskHeader.Controls.Add($taskLogo)
$taskTitle=New-Label '凤凰鸣' 88 19 300 36 21;$taskTitle.ForeColor=[Drawing.Color]::White;$taskTitle.Font=New-Object Drawing.Font('Microsoft YaHei UI',21,[Drawing.FontStyle]::Bold)
$taskSubtitle=New-Label '播放电脑 · 本机控制台' 90 58 600 22 9;$taskSubtitle.ForeColor=[Drawing.Color]::FromArgb(166,177,204)
$taskVersion=New-Label 'AGENT 0.1.4' 806 26 206 26 10;$taskVersion.ForeColor=[Drawing.Color]::FromArgb(218,199,255);$taskVersion.TextAlign='MiddleRight'
$taskChecked=New-Label '正在检查服务…' 706 57 306 22 9;$taskChecked.ForeColor=[Drawing.Color]::FromArgb(166,177,204);$taskChecked.TextAlign='MiddleRight'
$taskHeader.Controls.AddRange(@($taskTitle,$taskSubtitle,$taskVersion,$taskChecked))
$taskServiceCard=New-Card 28 110 316 96;$taskServerCard=New-Card 362 110 316 96;$taskPlayerCard=New-Card 696 110 316 96;$taskForm.Controls.AddRange(@($taskServiceCard,$taskServerCard,$taskPlayerCard))
$taskServiceTitle=New-Label 'WINDOWS 服务' 16 10 280 23 9;$taskServiceStatus=New-Label '正在检查' 16 35 280 28 12;$taskServiceDetail=New-Label 'QQMusicAgent' 16 68 282 18 9
$taskServerTitle=New-Label '后端连接' 16 10 280 23 9;$taskServerStatus=New-Label '等待本机服务' 16 35 280 28 12;$taskServerDetail=New-Label '设备认证与歌曲指令' 16 68 282 18 9
$taskPlayerTitle=New-Label '用户播放器' 16 10 280 23 9;$taskPlayerStatus=New-Label '等待本机服务' 16 35 280 28 12;$taskPlayerDetail=New-Label 'mpv · Windows 默认音频输出' 16 68 282 18 9
$taskServiceCard.Controls.AddRange(@($taskServiceTitle,$taskServiceStatus,$taskServiceDetail));$taskServerCard.Controls.AddRange(@($taskServerTitle,$taskServerStatus,$taskServerDetail));$taskPlayerCard.Controls.AddRange(@($taskPlayerTitle,$taskPlayerStatus,$taskPlayerDetail))
foreach($label in @($taskServiceStatus,$taskServerStatus,$taskPlayerStatus)){$label.TextAlign='MiddleLeft';Set-Indicator $label $label.Text 'idle'}
$taskTabs=New-Object Windows.Forms.TabControl;$taskTabs.Location=New-Object Drawing.Point(28,220);$taskTabs.Size=New-Object Drawing.Size(984,(440-$taskCompact));$taskTabs.Font=New-Object Drawing.Font('Microsoft YaHei UI',10);$taskTabs.DrawMode='OwnerDrawFixed';$taskTabs.SizeMode='Fixed';$taskTabs.ItemSize=New-Object Drawing.Size(146,38)
$taskTabs.Add_DrawItem({param($sender,$eventArgs)$selected=$eventArgs.Index -eq $sender.SelectedIndex;$background=if($selected){[Drawing.Color]::FromArgb(237,234,250)}else{[Drawing.Color]::FromArgb(243,245,250)};$foreground=if($selected){[Drawing.Color]::FromArgb(99,79,171)}else{[Drawing.Color]::FromArgb(115,124,143)};$brush=New-Object Drawing.SolidBrush($background);$eventArgs.Graphics.FillRectangle($brush,$eventArgs.Bounds);$brush.Dispose();[Windows.Forms.TextRenderer]::DrawText($eventArgs.Graphics,$sender.TabPages[$eventArgs.Index].Text,$sender.Font,$eventArgs.Bounds,$foreground,([Windows.Forms.TextFormatFlags]::HorizontalCenter -bor [Windows.Forms.TextFormatFlags]::VerticalCenter))})
$taskOverviewTab=New-Object Windows.Forms.TabPage;$taskOverviewTab.Text='播放总览';$taskOverviewTab.BackColor=[Drawing.Color]::White;$taskOverviewTab.AutoScroll=$true
$taskLogsTab=New-Object Windows.Forms.TabPage;$taskLogsTab.Text='运行日志';$taskLogsTab.BackColor=[Drawing.Color]::White;$taskTabs.TabPages.AddRange(@($taskOverviewTab,$taskLogsTab));$taskForm.Controls.Add($taskTabs)
$taskConnection=New-Label '正在读取本机服务状态…' 24 14 890 24 9
$taskSong=New-Label '暂无正在播放的歌曲' 24 48 800 42 24;$taskSong.Font=New-Object Drawing.Font('Microsoft YaHei UI',24,[Drawing.FontStyle]::Bold)
$taskArtists=New-Label '' 25 94 880 23 10
$taskPosition=New-Label '00:00 / 00:00' 24 129 205 26 10
$taskSeekBar=New-Object Windows.Forms.TrackBar;$taskSeekBar.Location=New-Object Drawing.Point(236,121);$taskSeekBar.Size=New-Object Drawing.Size(704,40);$taskSeekBar.Minimum=0;$taskSeekBar.Maximum=0;$taskSeekBar.SmallChange=1;$taskSeekBar.LargeChange=1;$taskSeekBar.TickStyle='None';$taskSeekBar.Enabled=$false;$taskSeekBar.BackColor=[Drawing.Color]::White
$taskSeekLabel=New-Label '跳到（秒）' 24 175 98 26 10
$taskSeekTarget=New-Object Windows.Forms.NumericUpDown;$taskSeekTarget.Location=New-Object Drawing.Point(124,173);$taskSeekTarget.Width=92;$taskSeekTarget.Minimum=0;$taskSeekTarget.Maximum=0;$taskSeekTarget.DecimalPlaces=0;$taskSeekTarget.Increment=1;$taskSeekTarget.Font=New-Object Drawing.Font('Microsoft YaHei UI',10);$taskSeekTarget.Enabled=$false
$taskJump=New-Button '跳转' 232 166 96;$taskBack=New-Button '−1 秒' 342 166 84;$taskForward=New-Button '+1 秒' 438 166 84
$script:taskSeekUpdating=$false;$script:taskSeekEdited=$false;$script:taskCanSeek=$false;$script:taskLastPosition=0;$script:taskLastPlaybackId=$null
$taskPause=New-Button '暂停' 558 166 84;$taskResume=New-Button '继续' 654 166 84;$taskVolumeLabel=New-Label '音量' 758 176 46 23 10
$taskVolume=New-Object Windows.Forms.NumericUpDown;$taskVolume.Location=New-Object Drawing.Point(803,173);$taskVolume.Width=57;$taskVolume.Minimum=0;$taskVolume.Maximum=100;$taskVolume.Value=50;$taskVolume.Font=New-Object Drawing.Font('Microsoft YaHei UI',10)
$taskSetVolume=New-Button '应用' 874 166 65
$taskTransfer=New-Label '当前没有下载任务' 24 224 904 24 9
$taskProgress=New-Object Windows.Forms.ProgressBar;$taskProgress.Location=New-Object Drawing.Point(26,256);$taskProgress.Size=New-Object Drawing.Size(908,8)
$taskQueueTitle=New-Label '待播列表' 24 282 400 24 10
$taskQueue=New-Object Windows.Forms.ListView;$taskQueue.Location=New-Object Drawing.Point(24,311);$taskQueue.Size=New-Object Drawing.Size(916,76);$taskQueue.View='Details';$taskQueue.FullRowSelect=$true;$taskQueue.BorderStyle='None';$taskQueue.Font=New-Object Drawing.Font('Microsoft YaHei UI',9);$taskQueue.Columns.Add('待播歌曲',408)|Out-Null;$taskQueue.Columns.Add('歌手',300)|Out-Null;$taskQueue.Columns.Add('状态',180)|Out-Null
$taskOverviewTab.Controls.AddRange(@($taskConnection,$taskSong,$taskArtists,$taskPosition,$taskSeekBar,$taskSeekLabel,$taskSeekTarget,$taskJump,$taskBack,$taskForward,$taskTransfer,$taskProgress,$taskPause,$taskResume,$taskVolumeLabel,$taskVolume,$taskSetVolume,$taskQueueTitle,$taskQueue))
$taskLogBox=New-Object Windows.Forms.RichTextBox;$taskLogBox.Dock='Fill';$taskLogBox.ReadOnly=$true;$taskLogBox.BorderStyle='None';$taskLogBox.BackColor=[Drawing.Color]::FromArgb(28,36,59);$taskLogBox.ForeColor=[Drawing.Color]::FromArgb(213,225,244);$taskLogBox.Font=New-Object Drawing.Font('Consolas',10);$taskLogBox.WordWrap=$false;$taskLogsTab.Controls.Add($taskLogBox)
$taskSettingsCard=New-Card 28 (679-$taskCompact) 648 151;$taskSafetyCard=New-Card 696 (679-$taskCompact) 316 151;$taskForm.Controls.AddRange(@($taskSettingsCard,$taskSafetyCard))
$taskSettingsTitle=New-Label '连接设置' 16 12 500 30 13;$taskEndpointLabel=New-Label '服务器端点' 16 55 91 26 9
$taskEndpoint=New-Object Windows.Forms.TextBox;$taskEndpoint.Location=New-Object Drawing.Point(114,52);$taskEndpoint.Size=New-Object Drawing.Size(516,27);$taskEndpoint.Font=New-Object Drawing.Font('Microsoft YaHei UI',10);$taskEndpoint.Text=$taskSettings.serverUrl
$taskTokenLabel=New-Label '设备凭证' 16 101 91 26 9
$taskToken=New-Object Windows.Forms.TextBox;$taskToken.Location=New-Object Drawing.Point(114,98);$taskToken.Size=New-Object Drawing.Size(362,27);$taskToken.UseSystemPasswordChar=$true;$taskToken.Font=New-Object Drawing.Font('Microsoft YaHei UI',10)
$taskSave=New-Button '保存并重连' 490 94 140;$taskSettingsCard.Controls.AddRange(@($taskSettingsTitle,$taskEndpointLabel,$taskEndpoint,$taskTokenLabel,$taskToken,$taskSave))
$taskSafetyTitle=New-Label '安全控制' 16 12 284 30 13;$taskBrake=New-Button '立即制动' 16 52 161;$taskBrake.BackColor=[Drawing.Color]::FromArgb(205,62,82);$taskBrake.ForeColor=[Drawing.Color]::White;$taskBrake.Font=New-Object Drawing.Font('Microsoft YaHei UI',13,[Drawing.FontStyle]::Bold);$taskBrake.Height=60
$taskRelease=New-Button '解除制动' 191 63 110;$taskSafetyDetail=New-Label '停止声音并锁定设备，解除后不重播。' 16 122 288 19 9;$taskSafetyCard.Controls.AddRange(@($taskSafetyTitle,$taskBrake,$taskRelease,$taskSafetyDetail))
$taskHint=New-Label '凭证留空保持原值。制动锁会保留到手动解除。' 30 (842-$taskCompact) 982 22 9;$taskForm.Controls.Add($taskHint)
function Refresh-ServiceIndicator {
  try {
    $service=Get-Service -Name QQMusicAgent -ErrorAction Stop
    $state=[string]$service.Status;$mode=[string]$service.StartType
    switch($state){'Running'{Set-Indicator $taskServiceStatus '● 已注册 · 运行中' 'good'}'Stopped'{Set-Indicator $taskServiceStatus '● 已注册 · 已停止' 'bad'}'StartPending'{Set-Indicator $taskServiceStatus '● 已注册 · 正在启动' 'warn'}'StopPending'{Set-Indicator $taskServiceStatus '● 已注册 · 正在停止' 'warn'}default{Set-Indicator $taskServiceStatus "● 已注册 · $state" 'warn'}}
    $taskServiceDetail.Text="QQMusicAgent · $(if($mode -eq 'Automatic'){'开机启动'}elseif($mode -eq 'Manual'){'手动启动'}elseif($mode -eq 'Disabled'){'已禁用'}else{$mode})"
  } catch {
    if($_.FullyQualifiedErrorId -like '*NoServiceFound*'){Set-Indicator $taskServiceStatus '● 未注册服务' 'warn';$taskServiceDetail.Text='可前台运行；开机服务需执行 --install'}else{Set-Indicator $taskServiceStatus '● 无法读取服务状态' 'bad';$taskServiceDetail.Text='请检查 Windows 服务查询权限'}
  }
  $taskChecked.Text="服务检查 $(Get-Date -Format 'HH:mm:ss')"
}
function Show-Failure($ErrorValue) { [Windows.Forms.MessageBox]::Show([string]$ErrorValue,'凤凰鸣',[Windows.Forms.MessageBoxButtons]::OK,[Windows.Forms.MessageBoxIcon]::Error) | Out-Null }
$taskSave.Add_Click({ try { $body=@{endpoint=$taskEndpoint.Text.Trim()}; if ($taskToken.Text.Trim()) { $body.token=$taskToken.Text.Trim() }; Send-Control '/config' $body; $taskToken.Clear(); $taskHint.Text='端点已保存并重连；确认连接正常后可解除制动。' } catch { Show-Failure $_.Exception.Message } })
$taskPause.Add_Click({ try { Send-Control '/control' @{action='pause'} } catch { Show-Failure $_.Exception.Message } })
$taskResume.Add_Click({ try { Send-Control '/control' @{action='resume'} } catch { Show-Failure $_.Exception.Message } })
$taskSetVolume.Add_Click({ try { Send-Control '/control' @{action='volume';volume=[int]$taskVolume.Value} } catch { Show-Failure $_.Exception.Message } })
function Seek-To([int]$Position) {
  if(-not $script:taskCanSeek){return}
  $target=[Math]::Max(0,[Math]::Min($taskSeekBar.Maximum,$Position))
  try { Send-Control '/control' @{action='seek';position=$target}; $script:taskLastPosition=$target; $script:taskSeekEdited=$false; $script:taskSeekUpdating=$true; $taskSeekBar.Value=$target; $taskSeekTarget.Value=$target; $taskHint.Text="已跳到 $(Time-Text $target)（$target 秒）。" } catch { Show-Failure $_.Exception.Message } finally { $script:taskSeekUpdating=$false }
}
$taskSeekTarget.Add_ValueChanged({if(-not $script:taskSeekUpdating){$script:taskSeekEdited=$true}})
$taskJump.Add_Click({Seek-To ([int]$taskSeekTarget.Value)})
$taskBack.Add_Click({Seek-To ([int][Math]::Floor($script:taskLastPosition)-1)})
$taskForward.Add_Click({Seek-To ([int][Math]::Floor($script:taskLastPosition)+1)})
$taskSeekBar.Add_MouseUp({Seek-To $taskSeekBar.Value})
$taskSeekBar.Add_KeyUp({if($_.KeyCode -in @('Left','Right','Up','Down','PageUp','PageDown','Home','End')){Seek-To $taskSeekBar.Value}})
$taskSeekBar.Add_Scroll({$script:taskSeekUpdating=$true;$taskSeekTarget.Value=$taskSeekBar.Value;$script:taskSeekUpdating=$false})
$taskBrake.Add_Click({
  try {
    $stateFile=Join-Path $taskDirectory 'control-state.json'; [IO.File]::WriteAllText($stateFile+'.console.tmp','{"emergencyStopped":true}',(New-Object Text.UTF8Encoding($false))); Move-Item -LiteralPath ($stateFile+'.console.tmp') -Destination $stateFile -Force
    $taskHasher=[Security.Cryptography.SHA256]::Create(); $instance=([BitConverter]::ToString($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskSecret)))).Replace('-','').ToLowerInvariant().Substring(0,16); $taskHasher.Dispose()
    $pipeName="qqmusic-mpv-$instance"
    $taskStopPipe=$null
    try { $taskStopPipe=New-Object IO.Pipes.NamedPipeClientStream('.',$pipeName,[IO.Pipes.PipeDirection]::Out);$taskStopPipe.Connect(50);$taskStopBytes=[Text.Encoding]::UTF8.GetBytes("{`"command`": [`"stop`"]}`n");$taskStopPipe.Write($taskStopBytes,0,$taskStopBytes.Length);$taskStopPipe.Flush() } catch {} finally { if($taskStopPipe){$taskStopPipe.Dispose()} }
    $taskConnection.Text='本机已紧急制动'; $taskConnection.ForeColor=[Drawing.Color]::Firebrick; $taskHint.Text='已停止声音，制动锁已保存。'
    try { Send-Control '/brake' @{blocked=$true} } catch {
      try { Get-CimInstance Win32_Process -Filter "Name='mpv.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($pipeName) -and $_.ExecutablePath -eq $taskSettings.mpvPath } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } } catch {}
      $taskHint.Text='制动锁已保存；服务暂时不可达，恢复后仍需手动解除。'
    }
  } catch { Show-Failure $_.Exception.Message }
})
$taskRelease.Add_Click({ try { Send-Control '/brake' @{blocked=$false}; $taskHint.Text='本机制动已解除。' } catch { Show-Failure $_.Exception.Message } })
function Apply-State($State) {
  if($State.version){$taskVersion.Text="AGENT $($State.version)"}
  $serverText=if($State.authorized){'后端已连接'}elseif($State.serverConnected){'正在确认设备身份'}else{'后端未连接'}
  $playerText=if($State.recovering){'正在恢复音频播放'}elseif($State.playerReady){'播放器就绪'}elseif($State.playerConnected){'播放器未就绪'}else{'用户播放器未连接'}
  $zoneText=if($State.overview.zone.name){" · $($State.overview.zone.name)"}else{''}
  $taskConnection.Text=if($State.emergencyStopped){"已紧急制动 · $serverText$zoneText"}else{"$serverText · $playerText$zoneText"}
  $taskConnection.ForeColor=if($State.emergencyStopped){[Drawing.Color]::Firebrick}else{[Drawing.Color]::FromArgb(38,76,117)}
  Set-Indicator $taskServerStatus $(if($State.authorized){'● 已连接并认证'}elseif($State.serverConnected){'● 正在认证'}else{'● 未连接'}) $(if($State.authorized){'good'}elseif($State.serverConnected){'warn'}else{'bad'})
  $taskServerDetail.Text=if($State.overview.zone.name){"播放区 · $($State.overview.zone.name)"}else{'等待后端设备注册与认证'}
  Set-Indicator $taskPlayerStatus $(if($State.emergencyStopped){'● 制动锁定'}elseif($State.recovering){'● 正在恢复'}elseif($State.playerReady -and $State.started){if($State.paused){'● 已暂停'}else{'● 正在播放'}}elseif($State.playerReady){'● 已就绪'}elseif($State.playerConnected){'● 未就绪'}else{'● 未连接'}) $(if($State.emergencyStopped){'bad'}elseif($State.recovering -or ($State.playerConnected -and -not $State.playerReady)){'warn'}elseif($State.playerReady){'good'}else{'idle'})
  foreach($control in @($taskPause,$taskResume,$taskSetVolume)){$control.Enabled=[bool]($State.playerReady -and -not $State.emergencyStopped)}
  $taskRelease.Enabled=[bool]$State.emergencyStopped
  $taskSong.Text=if($State.current.title){$State.current.title}else{'暂无正在播放的歌曲'}
  $taskArtists.Text=if($State.current.artists){$State.current.artists -join ' / '}else{''}
  $duration=if($State.durationSeconds -gt 0){[double]$State.durationSeconds}else{[double]$State.current.durationSeconds}
  $taskPosition.Text="$(Time-Text $State.position) / $(Time-Text $duration)$(if($State.paused){' · 已暂停'})"
  $script:taskLastPosition=[double]$State.position
  if($script:taskLastPlaybackId -ne $State.playbackId){$script:taskSeekEdited=$false;$script:taskLastPlaybackId=$State.playbackId}
  $script:taskCanSeek=[bool]($State.started -and $State.seekable -and $State.playerReady -and -not $State.emergencyStopped -and $duration -gt 0)
  $script:taskSeekUpdating=$true
  try {
    $maximum=[int][Math]::Max(0,[Math]::Min(86399,[Math]::Floor($duration)-1)); $taskSeekBar.Maximum=$maximum; $taskSeekTarget.Maximum=$maximum
    if(-not $taskSeekBar.Capture){$taskSeekBar.Value=[int][Math]::Min($maximum,[Math]::Floor($script:taskLastPosition))}
    if(-not $taskSeekTarget.Focused -and -not $script:taskSeekEdited -and -not $taskSeekBar.Capture){$taskSeekTarget.Value=$taskSeekBar.Value}
  } finally { $script:taskSeekUpdating=$false }
  foreach($control in @($taskSeekBar,$taskSeekTarget,$taskJump,$taskBack,$taskForward)){$control.Enabled=$script:taskCanSeek}
  if($State.transfer){$taskTransfer.Text=('下载中：{0:N1} / {1:N1} MB · {2:N0} KB/s · {3} 路' -f ($State.transfer.bytes/1MB),($State.transfer.total/1MB),($State.transfer.speedBytesPerSecond/1KB),$State.transfer.connections); $taskProgress.Value=[Math]::Min(100,[int](100*$State.transfer.bytes/[Math]::Max(1,$State.transfer.total)))}else{$taskTransfer.Text='当前没有下载任务';$taskProgress.Value=0}
  if(-not $taskEndpoint.Focused){$taskEndpoint.Text=$State.endpoint}
  $taskQueue.BeginUpdate();$taskQueue.Items.Clear();foreach($song in $State.overview.queue){$row=New-Object Windows.Forms.ListViewItem([string]$song.title);$row.SubItems.Add(($song.artists -join ' / ')) | Out-Null;$row.SubItems.Add([string]$song.status) | Out-Null;$taskQueue.Items.Add($row) | Out-Null};$taskQueue.EndUpdate()
}
$taskTimer=New-Object Windows.Forms.Timer; $taskTimer.Interval=250
$taskTimer.Add_Tick({
  $script:taskTicks++
  if($script:taskTicks % 20 -eq 0){Refresh-ServiceIndicator}
  try {
    if($script:taskPending -and $script:taskPending.IsCompleted){$response=$script:taskPending.GetAwaiter().GetResult();if(-not $response.IsSuccessStatusCode){throw '无法读取本机服务状态'};Apply-State ($response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json);$response.Dispose();$script:taskPending=$null}
    if(-not $script:taskPending -and $script:taskTicks % 4 -eq 0){$script:taskPending=$taskClient.GetAsync((Local-Url '/state'))}
    if($script:taskLogPending -and $script:taskLogPending.IsCompleted){$response=$script:taskLogPending.GetAwaiter().GetResult();if($response.IsSuccessStatusCode){$text=($response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json).text;if($text -ne $taskLogBox.Text){$taskLogBox.Text=$text;$taskLogBox.SelectionStart=$taskLogBox.TextLength;$taskLogBox.ScrollToCaret()}};$response.Dispose();$script:taskLogPending=$null}
    if(-not $script:taskLogPending -and $script:taskTicks % 20 -eq 0){$script:taskLogPending=$taskClient.GetAsync((Local-Url '/logs'))}
  }catch{$script:taskPending=$null;$script:taskLogPending=$null;$script:taskCanSeek=$false;foreach($control in @($taskSeekBar,$taskSeekTarget,$taskJump,$taskBack,$taskForward,$taskPause,$taskResume,$taskSetVolume)){$control.Enabled=$false};$taskConnection.Text='本机服务不可达，请检查 QQMusicAgent 服务';$taskConnection.ForeColor=[Drawing.Color]::Firebrick;Set-Indicator $taskServerStatus '● 本机服务不可达' 'bad';Set-Indicator $taskPlayerStatus '● 状态未知' 'idle';$taskServerDetail.Text='连接状态暂时无法读取'}
})
$taskForm.Add_FormClosed({$taskTimer.Stop();$taskTimer.Dispose();$taskClient.Dispose()})
Refresh-ServiceIndicator
if($PreviewPath){$taskForm.StartPosition='Manual';$taskForm.Location=New-Object Drawing.Point(-3000,-3000);Apply-State @{endpoint='http://music.example.com';authorized=$true;serverConnected=$true;playerConnected=$true;playerReady=$true;emergencyStopped=$false;playbackId='preview';started=$true;seekable=$true;durationSeconds=235;position=68;current=@{title='示例歌曲';artists=@('示例歌手');durationSeconds=235};overview=@{zone=@{name='食堂'};queue=@(@{title='下一首歌曲';artists=@('歌手');status='已预热'})}};$taskForm.Show();$bitmap=New-Object Drawing.Bitmap($taskForm.Width,$taskForm.Height);$taskForm.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$taskForm.Width,$taskForm.Height)));$bitmap.Save([IO.Path]::GetFullPath($PreviewPath),[Drawing.Imaging.ImageFormat]::Png);$bitmap.Dispose();$taskForm.Close();Write-Output '控制台界面检查通过。'}else{$taskTimer.Start();[void]$taskForm.ShowDialog()}
$taskForm.Dispose()
