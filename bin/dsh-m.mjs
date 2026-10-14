#!/usr/bin/env node
/**
 * DSH-M 的命令行入口（也是自测入口）。
 *
 * 为什么要它：界面出问题时，能不开界面就验证采集器到底行不行。
 *   node bin/dsh-m.mjs collect            采集一次，打印各类数量与告警
 *   node bin/dsh-m.mjs collect --json     输出完整 JSON（给机器看）
 *   node bin/dsh-m.mjs collect --full     打印每个条目的中文说明（给人看）
 *   node bin/dsh-m.mjs action <group> <action> <id> [profile]
 */
import { collectAll, performAction } from '../lib/registry.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'collect';
const has = (f) => argv.includes('--' + f);

if (cmd === 'collect') {
  const s = await collectAll();
  if (has('json')) { console.log(JSON.stringify(s, null, 2)); process.exit(0); }

  console.log(`DSH-M 采集完成    ${s.generatedAt}`);
  console.log(`DSH 家目录: ${s.home}`);
  console.log('');
  for (const g of s.groups) {
    const items = s.items[g.key] || [];
    const on = items.filter((x) => x.enabled).length;
    console.log(`【${g.zh}】共 ${g.count} 项（启用 ${on}） —— ${g.desc}`);
    if (has('full')) {
      for (const it of items) {
        const flag = it.enabled ? '●' : '○';
        const prot = it.protected ? ' 🔒' : '';
        console.log(`   ${flag} ${it.title}${prot}`);
        console.log(`       ${it.zh || '(还没有中文说明)'}`);
        if (it.healthText) console.log(`       ⚠ ${it.healthText}`);
      }
    } else {
      const names = items.slice(0, 8).map((x) => x.title + (x.enabled ? '' : '(已关)'));
      console.log('   ' + (names.join('、') || '(无)') + (items.length > 8 ? ` … 还有 ${items.length - 8} 项` : ''));
    }
    console.log('');
  }
  if (s.sessionTotal) console.log('会话占用: ' + s.sessionTotal.text);
  if (s.trash.length) console.log('回收站: ' + s.trash.length + ' 条可还原');
  if (s.errors.length) {
    console.log('\n⚠ 部分采集失败（其余不受影响）:');
    for (const e of s.errors) console.log(`   ${e.group}: ${e.error}`);
  }
  process.exit(s.errors.length ? 0 : 0);
}

if (cmd === 'action') {
  const [, group, action, id, profile] = argv;
  const r = await performAction({ group, action, id, profile });
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

console.log(`用法:
  node bin/dsh-m.mjs collect [--json] [--full]
  node bin/dsh-m.mjs action <group> <action> <id> [profile]`);
process.exit(2);
