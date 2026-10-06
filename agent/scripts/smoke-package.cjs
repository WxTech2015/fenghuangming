const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const { connect } = require('node:net');
const { mkdtemp, readFile, readdir, rm, access, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');

const executable = resolve(__dirname, '../release/windows-x64/fenghuangming-agent.exe');
const token = `packaged-agent-test-${randomUUID()}`;
const environment = { ...process.env, PATH: join(process.env.SystemRoot, 'System32'), NODE_OPTIONS: '',
  FENGHUANGMING_SERVER: '', FENGHUANGMING_TOKEN: '' };
function start(args, directory, program = executable) {
  const child = spawn(program, args, { cwd: directory, env: environment, windowsHide: true });
  child.output = ''; child.stdout.on('data', data => { child.output += data; }); child.stderr.on('data', data => { child.output += data; });
  child.completion = new Promise((accept, reject) => { child.once('error', reject); child.once('close', code => accept(code)); });
  return child;
}
async function completed(child) {
  const result = await Promise.race([child.completion, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('程序执行超时')), 20000); timer.unref();
  })]);
  assert.equal(result, 0, child.output);
  return child.output;
}
async function waitUntil(check, child, timeout = 12000) {
  const start = Date.now();
  while (!await check()) {
    if (child.exitCode !== null) throw new Error(`Agent 意外退出：${child.output}`);
    if (Date.now() - start > timeout) throw new Error(`等待 Agent 超时：${child.output}`);
    await new Promise(accept => setTimeout(accept, 30));
  }
}
async function stopTree(child, pipe) {
  if (!child || child.exitCode !== null || !Number.isInteger(child.pid) || child.pid < 2) return;
  // Close only this test's mpv instance before terminating the foreground Agent.
  await new Promise(accept => {
    const socket = connect(pipe);
    const timer = setTimeout(() => { socket.destroy(); accept(); }, 2000);
    socket.once('close', () => clearTimeout(timer));
    socket.once('error', accept); socket.once('close', accept);
    socket.once('connect', () => socket.end(JSON.stringify({ command: ['quit'] }) + '\n'));
  });
  child.kill();
  // 不等待被后代进程持有的输出管道，避免异常退出卡住清理。
  child.stdout.destroy(); child.stderr.destroy();
  await Promise.race([child.completion, new Promise(accept => setTimeout(accept, 3000))]);
}
function silence() {
  const samples = 44100 * 60; const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(44100, 24); buffer.writeUInt32LE(88200, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40); return buffer;
}
async function main() {
  await access(executable);
  const directory = await mkdtemp(join(tmpdir(), 'fenghuangming-package-'));
  const dataDir = join(directory, '播放数据 with spaces');
  const secret = createHash('sha256').update(`local-ipc:${token}`).digest('hex');
  const instance = createHash('sha256').update(secret).digest('hex').slice(0, 16);
  const pipe = `\\\\.\\pipe\\qqmusic-mpv-${instance}`;
  const audio = silence(); const sha256 = createHash('sha256').update(audio).digest('hex');
  const messages = []; let peer; let path; let authorization; let mediaRequests = 0; let mediaAuthorization;
  const http = createServer((request, response) => {
    if (request.url === '/healthz') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); return; }
    mediaRequests++; mediaAuthorization = request.headers.authorization;
    if (request.headers.range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
      assert(match); const start = Number(match[1]); const end = Number(match[2]);
      response.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Type': 'audio/wav', 'Content-Range': `bytes ${start}-${end}/${audio.length}`, ETag: `"${sha256}"` }); response.end(audio.subarray(start, end + 1)); return;
    }
    response.writeHead(200, { 'Content-Length': audio.length, 'Content-Type': 'audio/wav' }); response.end(audio);
  });
  const ws = new WebSocketServer({ server: http });
  ws.on('connection', (socket, request) => {
    peer = socket; path = request.url; authorization = request.headers.authorization;
    socket.on('message', bytes => {
      const data = JSON.parse(bytes.toString()); messages.push(data);
      if (data.type === 'hello') socket.send(JSON.stringify({ type: 'welcome', v: 1, epoch: 1, agentId: 'agent_test', zoneId: 'zone_test', leaseMs: 60000 }));
      if (data.type === 'playback') socket.send(JSON.stringify({ type: 'event-ack', eventId: data.eventId }));
    });
  });
  let child; let phase = '启动';
  try {
    http.listen(0, '127.0.0.2'); await once(http, 'listening');
    const endpoint = `http://127.0.0.2:${http.address().port}`;
    const args = ['--endpoint', endpoint, '--token', token, '--data-dir', dataDir];
    assert.match(await completed(start(['--help'], directory)), /--install/);
    assert.match(await completed(start(['--version'], directory)), /凤凰鸣 Agent 0\.1\.4/);
    assert.match(await completed(start([...args, '--check'], directory)), /mpv/);
    await access(join(dataDir, 'tools/nssm.exe'));
    await access(join(dataDir, 'tools/scripts/install-agent.ps1'));
    await access(join(dataDir, 'tools/scripts/desktop-console.ps1'));
    console.log('PASS 独立 exe、内置文件释放、健康检查和内置 mpv');
    const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const installerResult = await completed(start(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      resolve(__dirname, '../tests/install-plan.ps1'), '-InstallerPath', join(dataDir, 'tools/scripts/install-agent.ps1')], directory, powershell));
    assert.match(installerResult, /PASS Windows/);
    console.log('PASS Windows 安装参数与失败回滚模拟（未注册服务或登录任务）');
    child = start(args, directory);
    await waitUntil(() => messages.some(message => ['hello', 'heartbeat'].includes(message.type) && message.ready), child);
    assert.equal(path, '/ws/agents'); assert.equal(authorization, `Bearer ${token}`);
    const send = (id, payload, extra = {}) => peer.send(JSON.stringify({ v: 1, kind: 'command', id,
      agentId: 'agent_test', zoneId: 'zone_test', epoch: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), payload, ...extra }));
    const play = { action: 'start', playbackId: 'play_test', queueItemId: 'item_test', assetId: 'asset_test',
      ticket: 'ticket', sha256, bytes: audio.length, mime: 'audio/wav', volume: 0 };
    send('cmd_play', play); send('cmd_play', play);
    await waitUntil(() => messages.some(message => message.type === 'playback' && message.state === 'started'), child);
    assert.equal(mediaRequests, 4); assert.equal(mediaAuthorization, `Bearer ${token}`);
    assert(messages.some(message => message.type === 'ack' && message.status === 'duplicate'));
    const cache = join(dataDir, 'cache'); const cached = (await readdir(cache)).filter(filename => !filename.endsWith('.part'));
    assert.equal(cached.length, 1); assert.deepEqual(await readFile(join(cache, cached[0])), audio);
    for (const action of ['pause', 'resume', 'volume']) {
      send(`cmd_${action}`, action === 'volume' ? { action, volume: 0 } : { action, playbackId: 'play_test' });
      await waitUntil(() => messages.some(message => message.type === 'ack' && message.commandId === `cmd_${action}` && message.status === 'accepted'), child);
      const expected = action === 'pause' ? true : action === 'resume' ? false : 0;
      const property = action === 'volume' ? 'volume' : 'pause';
      let value;
      for (let attempt = 0; attempt < 50; attempt++) {
        value = await queryMpv(pipe, property);
        if (value === expected) break;
        await new Promise(accept => setTimeout(accept, 20));
      }
      assert.equal(value, expected, `mpv ${property} 状态未更新`);
    }
    send('cmd_expired', play, { expiresAt: '2000-01-01T00:00:00.000Z' });
    send('cmd_wrong_agent', play, { agentId: 'agent_other' });
    await waitUntil(() => messages.filter(message => message.type === 'ack' && message.status === 'rejected').length === 2, child);
    send('cmd_stop', { action: 'stop', playbackId: 'play_test' });
    await waitUntil(() => messages.some(message => message.type === 'playback' && message.state === 'stopped'), child);
    console.log('PASS 反向 WebSocket、凭证、下载校验、真实 mpv 播放、暂停、继续、音量和停止');
    console.log('PASS 重复、过期、错误设备指令拒绝；测试音频为静音');
    const info = JSON.parse(await readFile(join(dataDir, 'control-info.json'), 'utf8'));
    const control = async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${info.port}${route}`, { signal: AbortSignal.timeout(5000), method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, 200); return response.json();
    };
    send('cmd_brake_play', { ...play, playbackId: 'play_brake' });
    await waitUntil(() => messages.some(message => message.type === 'playback' && message.playbackId === 'play_brake' && message.state === 'started'), child);
    let state;
    for (let attempt = 0; attempt < 100; attempt++) {
      state = await control('/state'); if (state.seekable && state.durationSeconds > 0) break;
      await new Promise(ok => setTimeout(ok, 30));
    }
    assert.equal(state.seekable, true); assert.equal(Math.round(state.durationSeconds), 60);
    assert(messages.find(message => message.type === 'hello').capabilities.includes('seek'));
    await control('/control', { action: 'pause' });
    send('cmd_remote_seek', { action: 'seek', playbackId: 'play_brake', position: 12 });
    await waitUntil(async () => Math.abs(await queryMpv(pipe, 'time-pos') - 12) < 0.1, child);
    assert.equal(await queryMpv(pipe, 'pause'), true);
    console.log('PASS 新版能力上报、远程整数秒跳转与暂停保持');
    phase = '本机整数秒跳转';
    for (const position of [17, 18, 17]) {
      await control('/control', { action: 'seek', position });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (Math.abs(await queryMpv(pipe, 'time-pos') - position) < 0.1) break;
        await new Promise(ok => setTimeout(ok, 20));
      }
      assert(Math.abs(await queryMpv(pipe, 'time-pos') - position) < 0.1); assert.equal(await queryMpv(pipe, 'pause'), true);
    }
    // Reinitialize the real WASAPI output, then simulate a native process exit.
    phase = '音频输出重新初始化';
    await mpvCommand(pipe, ['set_property', 'audio-device', 'auto']);
    assert.equal(await queryMpv(pipe, 'current-ao'), 'wasapi');
    const pid = await queryMpv(pipe, 'pid'); assert(Number.isInteger(pid) && pid > 1 && pid !== child.pid && pid !== process.pid);
    assert.equal(await queryMpv(pipe, 'path'), join(cache, cached[0]));
    phase = '播放器原位置恢复';
    process.kill(pid); // PID and cache path came from this test's dedicated mpv pipe.
    await waitUntil(async () => {
      state = await control('/state');
      if (state.playerReady && !state.recovering && state.playbackId === 'play_brake') { try { return await queryMpv(pipe, 'pid') !== pid; } catch { /* process restart has not finished yet */ } }
      return false;
    }, child, 15000);
    assert.equal(state.playbackId, 'play_brake'); assert.equal(state.playerReady, true); assert(Math.abs(await queryMpv(pipe, 'time-pos') - 17) < 0.2); assert.equal(await queryMpv(pipe, 'pause'), true);
    assert.equal(messages.filter(message => message.type === 'playback' && message.playbackId === 'play_brake' && message.state === 'started').length, 1);
    assert.equal(messages.filter(message => message.type === 'playback' && message.playbackId === 'play_brake' && message.state === 'failed').length, 0);
    console.log('PASS 真实 mpv 1 秒跳转、暂停保持、WASAPI 重新初始化、进程退出后原位置恢复');
    phase = '桌面跳转与制动';
    const desktop = await readFile(join(dataDir, 'tools/scripts/desktop-console.ps1'), 'utf8');
    assert(desktop.includes('$taskForm.Show();$bitmap='));
    const desktopTest = join(directory, 'desktop-button-test.ps1'); const desktopConfig = join(directory, 'desktop.config.json');
    await writeFile(desktopTest, desktop.replace('$taskForm.Show();$bitmap=', "$taskForm.StartPosition='Manual';$taskForm.Location=New-Object Drawing.Point(-3000,-3000);$taskForm.Show();$taskSeekTarget.Value=23;$taskJump.PerformClick();Start-Sleep -Milliseconds 150;$r=$taskClient.GetAsync((Local-Url '/state')).GetAwaiter().GetResult();$s=$r.Content.ReadAsStringAsync().GetAwaiter().GetResult()|ConvertFrom-Json;$r.Dispose();if([Math]::Abs($s.position-23)-gt 0.2){throw 'Desktop seek failed'};$taskBrake.PerformClick();$bitmap="));
    await writeFile(desktopConfig, JSON.stringify({ serverUrl: endpoint, token, ipcSecret: secret, dataDir, mpvPath: join(dataDir, 'tools/mpv/mpv.exe') }));
    await completed(start(['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', desktopTest, '-ConfigPath', desktopConfig, '-PreviewPath', join(directory, 'desktop.png')], directory, powershell));
    await waitUntil(() => messages.some(message => message.type === 'playback' && message.playbackId === 'play_brake' && message.state === 'stopped'), child);
    assert.equal((await control('/state')).emergencyStopped, true);
    send('cmd_blocked', { ...play, playbackId: 'play_blocked' });
    await waitUntil(() => messages.some(message => message.type === 'ack' && message.commandId === 'cmd_blocked' && message.status === 'rejected'), child);
    assert.equal(JSON.parse(await readFile(join(dataDir, 'control-state.json'), 'utf8')).emergencyStopped, true);
    await control('/brake', { blocked: false });
    assert.equal((await control('/state')).emergencyStopped, false);
    console.log('PASS 桌面真实按钮、接口、mpv 即时制动、持久化、阻止远程重播和手动解除');
  } catch (error) {
    console.error(`发行包测试失败（${phase}）：`, error.message, child?.output ?? ''); throw error;
  } finally {
    await stopTree(child, pipe); for (const socket of ws.clients) socket.terminate(); ws.close(); http.closeAllConnections(); await new Promise(accept => http.close(accept));
    if (!directory.startsWith(join(tmpdir(), 'fenghuangming-package-'))) throw new Error('拒绝清理未知测试目录');
    await rm(directory, { recursive: true, force: true });
  }
}
async function queryMpv(pipe, property) {
  return mpvCommand(pipe, ['get_property', property]);
}
async function mpvCommand(pipe, command) {
  return new Promise((accept, reject) => {
    const socket = connect(pipe); let input = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`mpv 查询超时：${command.join(' ')}`)); }, 3000);
    socket.once('close', () => { clearTimeout(timer); reject(new Error(`mpv 查询中断：${command.join(' ')}`)); });
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ command, request_id: 1000 }) + '\n'));
    socket.on('data', chunk => {
      input += chunk;
      let newline;
      while ((newline = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, newline); input = input.slice(newline + 1);
        const data = JSON.parse(line);
        if (data.request_id === 1000) { socket.destroy(); data.error === 'success' ? accept(data.data) : reject(new Error(data.error)); return; }
      }
    });
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
