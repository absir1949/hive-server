function normalizeServerUrl(value) {
  const input = String(value || '').trim();
  if (!input) throw new Error('服务器地址不能为空');

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('服务器地址格式不正确，请填写 http:// 或 https:// 地址');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('服务器地址只支持 http:// 或 https://');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('服务器地址只能包含协议、主机和端口，不能包含路径或参数');
  }
  return parsed.origin;
}

module.exports = { normalizeServerUrl };
