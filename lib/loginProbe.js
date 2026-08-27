function detectLoginState({ href = '', title = '', text = '' } = {}) {
  const body = String(text || '');
  const url = String(href || '');

  if (/登录超时|请重新\s*登录|扫码登录/.test(body) && !/店铺管理|商品管理/.test(body)) {
    return { loggedIn: false, reason: 'login_prompt' };
  }
  if (/店铺管理|商品管理/.test(body)) {
    return { loggedIn: true, reason: 'dashboard' };
  }
  if (/store\.weixin\.qq\.com/.test(url) && /login|passwd/.test(url)) {
    return { loggedIn: false, reason: 'login_url' };
  }
  return { loggedIn: null, reason: 'unknown' };
}

module.exports = { detectLoginState };
