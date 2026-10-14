#!/usr/bin/env node
/**
 * 插件服务端测试 —— 不启动 DSH，直接调它的路由处理函数。
 *
 * 为什么要这样测：插件代码在应用内存里，改了要重启应用才生效。
 * 但"重启后到底对不对"不能靠猜 —— 这里用假 ctx 把 handler 抓出来直接调。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 沙箱化，避免测试真的去改真实配置
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-m-plugin-'));
process.env.DSH_HOME = SANDBOX;
fs.mkdirSync(path.join(SANDBOX, 'skills', 'hello'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, 'skills', 'hello', 'SKILL.md'),
  '---\nname: hello\ndescription: 测试技能\n---\n', 'utf8');

const mod = await import('../index.js');

const handlers = {};
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  inject: (deps, fn) => {
    // 模拟宿主注入 webServer；同时记录注册了哪些路由
    fn({
      webServer: {
        register: ({ path: p, handler }) => { handlers[p] = handler; return () => {}; },
      },
    });
  },
  effect: (fn) => { fn(); },
};

mod.apply(ctx, {});

const checks = [];
const check = (n, ok, extra = '') => { checks.push(ok); console.log((ok ? '✅ ' : '❌ ') + n + (extra ? '  ' + extra : '')); };

check('插件导出 name', mod.name === 'dsh-m', mod.name);
check('顶层 inject 为空数组（webServer 走可选注入，否则会静默不激活）',
  Array.isArray(mod.inject) && mod.inject.length === 0, JSON.stringify(mod.inject));
check('注册了状态路由 /dsh-m/state', typeof handlers['/dsh-m/state'] === 'function');
check('注册了操作路由 /dsh-m/action', typeof handlers['/dsh-m/action'] === 'function');
check('写出了激活标记文件（没有控制台时靠它判断有没有生效）',
  fs.existsSync(path.join(SANDBOX, '.dsh-m', 'activated.json')));

function fakeReq({ method = 'GET', url = '/', body = '', remote = '127.0.0.1' } = {}) {
  const req = {
    method, url,
    socket: { remoteAddress: remote },
    on(ev, fn) {
      if (ev === 'data' && body) fn(Buffer.from(body, 'utf8'));
      if (ev === 'end') fn();
      return req;
    },
  };
  return req;
}
function fakeRes() {
  const res = { code: 0, body: null, writeHead(c) { res.code = c; }, end(s) { res.body = JSON.parse(s); } };
  return res;
}

// ── 状态路由 ──
const r1 = fakeRes();
await handlers['/dsh-m/state'](fakeReq(), r1);
check('状态路由返回 200', r1.code === 200);
check('返回 6 个分类', (r1.body.groups || []).length === 6);
check('分类都带中文名', (r1.body.groups || []).every((g) => g.zh));
check('扫到了沙箱里的技能', (r1.body.items.skills || []).length === 1);
check('带回收站列表', Array.isArray(r1.body.trash));
check('带家目录路径', typeof r1.body.home === 'string', r1.body.home);

// ── 非本机访问必须拒绝 ──
const r2 = fakeRes();
await handlers['/dsh-m/state'](fakeReq({ remote: '192.0.2.50' }), r2);
check('外部 IP 访问被拒绝（403）', r2.code === 403, 'code=' + r2.code);

// ── 操作路由：停用技能 ──
const r3 = fakeRes();
await handlers['/dsh-m/action'](fakeReq({
  method: 'POST',
  body: JSON.stringify({ group: 'skills', action: 'disable', id: 'hello' }),
}), r3);
check('停用技能返回 200', r3.code === 200, r3.body && r3.body.error);
check('停用后状态里 enabled=false', r3.body.state.items.skills[0].enabled === false);
check('停用后原目录真的没了', !fs.existsSync(path.join(SANDBOX, 'skills', 'hello')));

// ── 操作路由：还原 ──
const r4 = fakeRes();
await handlers['/dsh-m/action'](fakeReq({
  method: 'POST',
  body: JSON.stringify({ group: 'skills', action: 'enable', id: 'hello' }),
}), r4);
check('启用回来返回 200', r4.code === 200);
check('启用后目录恢复', fs.existsSync(path.join(SANDBOX, 'skills', 'hello')));

// ── 错误路径 ──
const r5 = fakeRes();
await handlers['/dsh-m/action'](fakeReq({ method: 'POST', body: JSON.stringify({ group: 'skills', action: 'nope', id: 'hello' }) }), r5);
check('未知操作返回 400 且带错误原因', r5.code === 400 && !!r5.body.error, r5.body && r5.body.error);

const r6 = fakeRes();
await handlers['/dsh-m/action'](fakeReq({ method: 'POST', body: '{}' }), r6);
check('缺 action 参数返回 400', r6.code === 400);

// ── 密钥不能出现在任何接口输出里 ──
const raw = JSON.stringify(r1.body);
check('接口输出里没有密钥痕迹', !/sk-[A-Za-z0-9_-]{16,}/.test(raw));

// ── 客户端布局契约（真踩过：面板不滚，藏在下面的东西老板看不见）──
//    官方 dsh-client-ui-sidebar-browser 的写法是
//    .root{height:100%;min-height:0;flex-direction:column;flex:auto;display:flex}
//    滚动区自己 overflow:auto。少任何一项，长内容就会被父容器裁掉。
const clientSrc = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
check('根容器设了 height:100%', /height:\s*'100%'/.test(clientSrc));
check('根容器设了 minHeight:0（flex 子项默认 min-height:auto，不加就撑破容器、滚动条不出现）', /minHeight:\s*0/.test(clientSrc));
check('根容器是纵向 flex', /flexDirection:\s*'column'/.test(clientSrc));
check('存在 overflowY:auto 的滚动区', /overflowY:\s*'auto'/.test(clientSrc));
check('顶部固定区标了 flex:none', /flex:\s*'none'/.test(clientSrc));

const bad = checks.filter((x) => !x).length;
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(bad === 0 ? `\n🎉 全部通过（${checks.length} 项）：路由、安全、启停链路都对` : `\n有 ${bad} / ${checks.length} 项没通过`);
process.exit(bad === 0 ? 0 : 1);
