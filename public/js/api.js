const ERROR_MESSAGES = {
  'Bad Request': '请求参数有误或数据已存在',
  'credential name or secret already exists': '凭据名称或访问密钥已存在，请勿重复创建',
  'upstream API Key verification failed': '上游通道 API Key 验证失败，请检查密钥是否有效',
  'upstream name or API Key already exists': '通道名称或 API Key 已存在，请勿重复添加',
  'one or more upstreams do not exist': '选中的上游通道不存在',
  'name, kind, and one or more upstreamIds are required': '名称、类型与绑定通道为必填项'
};

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
    const rawMsg = body?.message || body?.error || '请求失败';
    const msg = ERROR_MESSAGES[rawMsg] || rawMsg;
    const err = new Error(msg);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}
