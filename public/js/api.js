export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(path, { ...options, headers });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    if ((response.status === 429 && body?.blocked) || response.status === 401) {
      window.dispatchEvent(new CustomEvent('session-terminated', { detail: { status: response.status, body } }));
    }
    const err = new Error(body?.error || body?.message || '请求失败');
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}
