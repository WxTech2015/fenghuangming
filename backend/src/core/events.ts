import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { AgentLiveState, AudioEngine, NapCatBot, MusicRuntimeStatus } from '../contracts';
@Injectable()
export class Events {
  readonly changes = new Subject<{ data: { reason: string; at: string } }>();
  botConnected = false;
  readonly bots = new Map<string, NapCatBot>();
  // 能力与实际时长属于当前连接快照，重连时清除，不写入数据库。
  readonly agentPlayback = new Map<string, AgentLiveState>();
  onebotError: string | null = null;
  musicRuntime: MusicRuntimeStatus = { mode: 'managed', phase: 'uninstalled', installed: false, version: '', baseUrl: null, error: null };
  musicRuntimes: Partial<Record<AudioEngine, MusicRuntimeStatus>> = {};
  changed(reason: string) { this.changes.next({ data: { reason, at: new Date().toISOString() } }); }
}
