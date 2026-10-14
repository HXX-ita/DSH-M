/**
 * 找出 session_projcache 里的「孤儿」——缓存还在、但会话目录已经没了。
 * 这些就是 @ 补全菜单里那些点不开的「子智能体」条目。
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.DSH_HOME || 'D:\\deepseek\\.dsh';
const PC = path.join(HOME, 'storages', 'session_projcache', 'sessions');
const SESS = path.join(HOME, 'sessions');

// 现存会话 id
const live = new Set();
for (const ws of fs.readdirSync(SESS, { withFileTypes: true })) {
  if (!ws.isDirectory()) continue;
  for (const s of fs.readdirSync(path.join(SESS, ws.name), { withFileTypes: true })) {
    if (s.isDirectory()) live.add(s.name);
  }
}
console.log('现存会话目录: ' + live.size + ' 个');
live.forEach((x) => console.log('  ✅ ' + x));

const cached = fs.readdirSync(PC).filter((f) => f.endsWith('.json'));
console.log('\n缓存条目: ' + cached.length + ' 个');

const orphans = [];
const keep = [];
for (const f of cached) {
  const id = f.replace(/\.json$/, '');
  (live.has(id) ? keep : orphans).push({ id, file: path.join(PC, f) });
}

console.log('  缓存里还有、会话目录也在: ' + keep.length + ' 个');
keep.forEach((k) => console.log('    ✅ ' + k.id));
console.log('  🗑  孤儿（缓存还在但会话没了）: ' + orphans.length + ' 个');
orphans.slice(0, 8).forEach((o) => console.log('    - ' + o.id));
if (orphans.length > 8) console.log('    … 还有 ' + (orphans.length - 8) + ' 个');

if (process.argv.includes('--clean')) {
  let n = 0;
  for (const o of orphans) {
    try { fs.rmSync(o.file, { force: true }); n++; } catch { /* ignore */ }
  }
  console.log('\n✅ 已删 ' + n + ' 个孤儿缓存（都是会话已经不存在的）');
  console.log('   保留了 ' + keep.length + ' 个有效缓存。');
} else {
  console.log('\n（预演模式。加 --clean 才真删）');
}
