import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError } from '../core/errors';

export interface AuthConfig { username: string; password: string; secret: string; secure: boolean }
export class AuthService {
  private readonly attempts = new Map<string, { count: number; reset: number }>();
  constructor(readonly config: AuthConfig) {}
  login(username: string, password: string, request: Request, response: Response) {
    const key = request.ip ?? 'unknown'; const current = this.attempts.get(key); const attempt = current && current.reset > Date.now() ? current : { count: 0, reset: Date.now() + 600000 };
    attempt.count++; this.attempts.set(key, attempt);
    if (attempt.count > 20) throw new AppError('RATE_LIMITED', '登录尝试过多，请稍后重试', 429);
    const equal = (a: string, b: string) => { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
    if (!equal(username, this.config.username) || !equal(password, this.config.password)) throw new AppError('BAD_CREDENTIALS', '用户名或密码不正确', 401);
    this.attempts.delete(key);
    const payload = Buffer.from(JSON.stringify({ username, expires: Date.now() + 43200000, nonce: randomBytes(12).toString('hex') })).toString('base64url');
    const token = payload + '.' + this.sign(payload).toString('base64url');
    response.cookie('qqmusic_session', token, { httpOnly: true, secure: this.config.secure, sameSite: 'strict', maxAge: 43200000, path: '/' });
    return { username };
  }
  authenticated(request: Request) {
    const token = request.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('qqmusic_session='))?.slice('qqmusic_session='.length);
    if (!token) return false;
    const [payload, signature] = token.split('.'); if (!payload || !signature) return false;
    const actual = Buffer.from(signature, 'base64url'); const expected = this.sign(payload);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { username: string; expires: number }; return data.username === this.config.username && data.expires > Date.now(); } catch { return false; }
  }
  checkOrigin(request: Request) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return; // Non-browser clients still need the signed session.
    const expected = process.env.PUBLIC_URL ?? `${request.protocol}://${request.headers.host}`;
    if (origin !== expected) throw new AppError('BAD_ORIGIN', '请求来源不正确', 403);
  }
  private sign(payload: string) { return createHmac('sha256', this.config.secret).update(payload).digest(); }
}
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(AuthService) readonly auth: AuthService) {}
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    if (!this.auth.authenticated(request)) throw new AppError('UNAUTHORIZED', '请先登录', 401);
    this.auth.checkOrigin(request); return true;
  }
}
