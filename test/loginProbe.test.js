const test = require('node:test');
const assert = require('node:assert/strict');
const { detectLoginState } = require('../lib/loginProbe');

test('wechat shop dashboard text counts as logged in', () => {
  assert.deepEqual(detectLoginState({
    href: 'https://store.weixin.qq.com/shop/home',
    title: '微信小店',
    text: '首页 店铺管理 商品管理 订单管理',
  }), { loggedIn: true, reason: 'dashboard' });
});

test('login timeout text counts as logged out', () => {
  assert.deepEqual(detectLoginState({
    href: 'https://store.weixin.qq.com/shop/home',
    title: '微信小店',
    text: '登录超时，请重新 登录',
  }), { loggedIn: false, reason: 'login_prompt' });
});

test('unknown pages do not force a login failure', () => {
  assert.deepEqual(detectLoginState({
    href: 'https://www.1688.com/',
    title: '1688',
    text: '找货源',
  }), { loggedIn: null, reason: 'unknown' });
});
