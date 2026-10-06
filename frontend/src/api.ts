export class ApiError extends Error { constructor(readonly status: number, message: string, readonly traceId?: string) { super(traceId ? `${message}（追踪 ID：${traceId}）` : message); } }
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/v1' + path, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data: T & { message?: string; traceId?: string };
  try { data = await response.json(); }
  catch { throw new ApiError(response.status, `后端接口返回了非 JSON 内容（HTTP ${response.status}），请检查服务和网站转发`, response.headers.get('X-Trace-Id') ?? undefined); }
  if (!response.ok) throw new ApiError(response.status, data.message ?? '操作失败', data.traceId ?? response.headers.get('X-Trace-Id') ?? undefined); return data;
}
