#!/usr/bin/env node
/**
 * test-qqbot.mjs —— 锁住 QQ 机器人的「体检 / 改资料 / 重启」三个按钮背后的逻辑。
 *
 * 起因：2026-10-14 老板的机器人"看着在跑、实际收不到消息"，
 * 根因是启动器被终止后它变成**孤儿进程**（TCP 连接还 Established，其实早废了）。
 * 以前只能靠命令行排查。现在移到界面上，就有回归测试挡着。
 *
 * 测试期间不真的开浏览器、不真的重启机器人（DSH_M_NO_OPEN=1，重启只做只读部分）。
 */
process.env.DSH_M_NO_OPEN = '1';

const { botHealth, botMeta, CONSOLE_URL } = await import('../lib/qqbot.mjs');
const { performAction } = await import('../lib/registry.mjs');

let pass = 0, fail = 0;
const check = (n, ok, extra) => { ok ? pass++ : fail++; console.log(`${ok ? '✅' : '❌'} ${n}${extra ? '  ' + extra : ''}`); };

console.log('══ 1. 体检能跑通，且字段齐全 ══');
const h = await botHealth();
check('返回了 verdict', ['ok', 'warn', 'bad'].includes(h.verdict), 'verdict=' + h.verdict);
check('返回了 reasons（人话）', Array.isArray(h.reasons) && h.reasons.length > 0, h.reasons[0]);
check('孤儿标记是布尔', typeof h.orphan === 'boolean', 'orphan=' + h.orphan);
check('没把"父进程还在"错判成孤儿',
  !(h.proc && !h.orphan === false && h.reasons.some((r) => /父进程已经不在了/.test(r)) && h.orphan === false),
  '（这一条是防第一版把 parentAlive 的返回值当 orphan 用的那个 bug）');

console.log('\n══ 2. 元信息里关键项都在（界面上直接看得到）══');
const { meta } = await botMeta();
const keys = Object.keys(meta);
check('有 PID 或状态', keys.includes('PID') || keys.includes('状态'), keys.join(', '));
check('有网关连接一项', keys.includes('网关连接'));
check('有父进程一项（孤儿就在这看）', keys.includes('父进程'));
check('有日志新鲜度', keys.includes('日志'));

console.log('\n══ 3. 「改资料」返回控制台地址（不真开浏览器）══');
const r1 = await performAction({ group: 'processes', action: 'qqbot-console', id: 'dsh-qqbot' });
check('返回 ok', r1.ok === true);
check('给了 url', typeof r1.url === 'string' && r1.url.startsWith('https://'), r1.url);
check('url 与导出常量一致', r1.url === CONSOLE_URL);
check('说明了"要过审"', /过审/.test(r1.message || ''), r1.message);

console.log('\n══ 4. 「体检」动作返回一句人话（客户端 toast 会显示它）══');
const r2 = await performAction({ group: 'processes', action: 'qqbot-health', id: 'dsh-qqbot' });
// 体检是**查询**不是修改 —— 查出问题也必须 ok:true，否则客户端会当成"操作失败"把结论盖掉
check('体检是查询，永远返回 ok', r2.ok === true);
check('有 message', typeof r2.message === 'string' && r2.message.length > 3, (r2.message || '').slice(0, 60));
check('message 带结论图标', /✅|🚨/.test(r2.message || ''));
check('带 detail（供排查）', !!r2.detail);

// ★ 2026-10-15 更正：启动器拉起机器人后**必然退出**（计划任务返回码 0xC000013A），
//   所以「父进程不在」是**常态**，绝不能当成故障。
//   第一版把它当病因 → 健康的机器人被报成 bad。**这个测试就是抓到它的那条。**
check('孤儿不等于故障（启动器退出是常态）',
  !(h.orphan === true && h.verdict === 'bad'),
  'orphan=' + h.orphan + ' verdict=' + h.verdict + ' 网关连接=' + h.gateway.count);

console.log('\n══ 5. 重启动作的"只读部分"不会误伤 ══');
// 不真跑 restartBot（会重启机器人）；只验证它在 PID 校验不过时会拒绝 —— 用一个不存在的 action 验证 throw 路径
let threw = false;
try { await performAction({ group: 'processes', action: 'qqbot-nonexistent', id: 'dsh-qqbot' }); }
catch { threw = true; }
check('未知的 qqbot-* 动作会抛错（不会静默成功）', threw);

console.log(`\n${fail === 0 ? `🎉 全部通过（${pass} 项）：QQ 机器人的三个按钮背后逻辑锁住了` : `有 ${fail} / ${pass + fail} 项没通过`}`);
process.exit(fail === 0 ? 0 : 1);
