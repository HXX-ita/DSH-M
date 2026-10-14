#!/usr/bin/env node
/**
 * 看一眼仓库和 CI 的状态。
 *   node bin/status.mjs
 * 凭据同样走 git credential fill，且绝不回显。
 */
import { spawnSync, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.execArgv.includes('--use-system-ca') && !process.env.DSH_M_NO_RECERT) {
  const r = spawnSync(process.execPath, ['--use-system-ca', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, DSH_M_NO_RECERT: '1' } });
  process.exit(r.status === null ? 1 : r.status);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const child = execFile('git', ['credential', 'fill'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, cwd: ROOT });
let out = '';
child.stdin.end('protocol=https\nhost=github.com\n\n');
child.stdout.on('data', (d) => { out += d; });
await new Promise((res) => child.on('close', res));
const token = (/^password=(.*)$/m.exec(out) || [])[1];
if (!token) { console.log('❌ 没拿到凭据'); process.exit(3); }

const api = async (p) => {
  const r = await fetch('https://api.github.com' + p, {
    headers: { authorization: 'Bearer ' + token.trim(), accept: 'application/vnd.github+json', 'user-agent': 'DSH-M' },
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const repo = (await api('/repos/HXX-ita/DSH-M')).json;
if (!repo) { console.log('❌ 读不到仓库信息'); process.exit(4); }
console.log(`仓库: ${repo.full_name}　${repo.private ? '私有' : '公开'}　★${repo.stargazers_count}　默认分支 ${repo.default_branch}`);
console.log(`地址: ${repo.html_url}`);
console.log(`简介: ${repo.description || '(无)'}`);

const runs = (await api('/repos/HXX-ita/DSH-M/actions/runs?per_page=5')).json;
console.log('\n最近的 CI 运行:');
for (const r of (runs && runs.workflow_runs) || []) {
  const mark = r.conclusion === 'success' ? '✅' : (r.conclusion === 'failure' ? '❌' : '⏳');
  console.log(`  ${mark} ${r.name}　${r.head_branch}　${r.conclusion || r.status}　${new Date(r.created_at).toLocaleString()}`);
  console.log(`     ${r.html_url}`);
}
if (!runs || !runs.workflow_runs || !runs.workflow_runs.length) console.log('  （还没有运行记录，推送后可能要等几秒）');
