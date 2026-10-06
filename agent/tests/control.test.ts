import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalConsoleServer } from '../src/control';
import { parseConfig } from '../src/config';
it('桌面控制接口只开放本机、校验凭证和 Origin，日志不泄露凭证', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qqmusic-console-')); const token = 'private-token-'.repeat(4);
  const secret = parseConfig({ serverUrl: 'http://example.com', token, mpvPath: 'mpv.exe', dataDir: directory, ipcSecret: '' }, join(directory, 'config.json')).ipcSecret;
  const brake = vi.fn(async () => {}); const configure = vi.fn(async () => {});
  const control = vi.fn(); const server = new LocalConsoleServer(directory, secret, { state: () => ({ playerReady: true }), brake, configure, control, secrets: () => [token] }); await server.start();
  const url = `http://127.0.0.1:${server.port}`; const auth = { Authorization: `Bearer ${secret}` };
  try {
    expect((await fetch(url + '/state')).status).toBe(401); expect((await fetch(url + '/state', { headers: { ...auth, Origin: 'https://other.example' } })).status).toBe(401);
    expect(await (await fetch(url + '/state', { headers: auth })).json()).toEqual({ playerReady: true });
    expect((await fetch(url + '/brake', { method: 'POST', headers: auth, body: JSON.stringify({ blocked: true }) })).status).toBe(200); expect(brake).toHaveBeenCalledWith(true);
    expect((await fetch(url + '/config', { method: 'POST', headers: auth, body: JSON.stringify({ endpoint: 'http://example.com' }) })).status).toBe(200); expect(configure).toHaveBeenCalledWith('http://example.com', undefined);
    const seek = (position: unknown) => fetch(url + '/control', { method: 'POST', headers: auth, body: JSON.stringify({ action: 'seek', position }) });
    expect((await seek(17)).status).toBe(200); expect(control).toHaveBeenCalledWith('seek', 17);
    for (const invalid of [-1, 0.5, 86401, '17', null]) expect((await seek(invalid)).status).toBe(400);
    expect(control).toHaveBeenCalledOnce();
    await writeFile(join(directory, 'service.log'), `${token} ${secret} ticket=private-query&x=1`);
    const log = (await (await fetch(url + '/logs', { headers: auth })).json()).text; expect(log).not.toContain(token); expect(log).not.toContain(secret); expect(log).not.toContain('private-query');
  } finally { await server.close(); if (!resolve(directory).startsWith(resolve(tmpdir(), 'qqmusic-console-'))) throw new Error('Unexpected test directory'); await rm(directory, { recursive: true, force: true }); }
});
