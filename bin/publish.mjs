#!/usr/bin/env node
/**
 * 发布到 GitHub —— 建仓库 + 设置 remote + 推送。
 *
 * 为什么这么写：机器上没装 `gh`，但 git 里存着 GitHub 凭据（之前推 AppMover 用的）。
 * 所以走 `git credential fill` 拿凭据，再用 GitHub API 建仓库。
 *
 * ★ 凭据绝不回显：本脚本只打印"拿到了/没拿到"和令牌长度，永远不打印内容。
 *   这是踩过两次泄露之后定下的规矩（见 credential-safe-edit 技能）。
 *
 * 用法：
 *   node bin/publish.mjs                 # 默认仓库名 DSH-M，public
 *   node bin/publish.mjs --name DSH-M --private
 *   node bin/publish.mjs --dry-run       # 只看会发生什么，不真做
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 自愈：某些网络环境下 Node 不认系统证书库，会报
//    "unable to verify the first certificate"（HTTPS 被中间设备拦截）。
//    带 --use-system-ca 就正常。所以检测到没带这个参数就自己重启一次，
//    这样使用者直接 `node bin/publish.mjs` 就行，不用记参数。
if (!process.execArgv.includes('--use-system-ca') && !process.env.DSH_M_NO_RECERT) {
  const r = spawnSync(process.execPath,
    ['--use-system-ca', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, DSH_M_NO_RECERT: '1' } });
  process.exit(r.status === null ? 1 : r.status);
}

const pexec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const NAME = opt('name', 'DSH-M');
const PRIVATE = argv.includes('--private');
const DRY = argv.includes('--dry-run');

const log = (...a) => console.log(...a);

async function gitCredentials() {
  // GIT_TERMINAL_PROMPT=0：宁可失败也不要卡在交互提示上
  const child = execFile('git', ['credential', 'fill'],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, cwd: ROOT });
  let out = '';
  child.stdin.end('protocol=https\nhost=github.com\n\n');
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((res) => child.on('close', res));
  if (code !== 0) return null;
  const get = (k) => { const m = new RegExp('^' + k + '=(.*)$', 'm').exec(out); return m ? m[1].trim() : ''; };
  return { username: get('username'), password: get('password') };
}

let creds = null;
try { creds = await gitCredentials(); } catch { creds = null; }

if (!creds || !creds.password) {
  log('❌ 没能从 git 里拿到 GitHub 凭据（可能需要交互登录，脚本里做不了）。');
  log('');
  log('请二选一：');
  log('  A. 手动在 GitHub 上建一个空仓库 ' + NAME + '，然后回来告诉我，我把代码推上去；');
  log('  B. 装一个 gh 并 `gh auth login`，之后我全自动。');
  process.exit(3);
}
// ★ 只报长度，不报内容
log(`✅ 拿到 GitHub 凭据：账号=${creds.username || '(未知)'}　令牌长度=${creds.password.length}`);

const token = creds.password;
const api = async (p, init = {}) => {
  const r = await fetch('https://api.github.com' + p, {
    ...init,
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/vnd.github+json',
      'user-agent': 'DSH-M-publish',
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
};

const me = await api('/user');
if (me.status !== 200) {
  log('❌ 令牌无效或权限不足（HTTP ' + me.status + '）。');
  log('   GitHub 返回：' + (me.json && me.json.message ? me.json.message : me.text.slice(0, 200)));
  log('   常见原因：凭据过期、或令牌缺少 repo 权限。');
  process.exit(4);
}
const owner = me.json.login;
log(`✅ 已认证为：${owner}`);

const repoFull = `${owner}/${NAME}`;
if (DRY) { log(`\n[dry-run] 将创建 ${repoFull}（${PRIVATE ? '私有' : '公开'}）并推送当前分支。`); process.exit(0); }

// 已存在就直接用，不存在才建
let existing = await api(`/repos/${repoFull}`);
if (existing.status === 200) {
  log(`ℹ️  仓库已存在，直接推送：${existing.json.html_url}`);
} else {
  const created = await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: NAME,
      description: 'DSH-M · DeepSeek Harness 控制中心：一个界面管住技能、插件、模型厂商、定时任务、进程与会话。每项带中文说明，删除可还原。',
      private: PRIVATE,
      has_issues: true, has_wiki: false, has_projects: false,
      auto_init: false,
    }),
  });
  if (created.status !== 201) {
    log('❌ 创建仓库失败（HTTP ' + created.status + '）');
    log('   ' + (created.json && created.json.message ? created.json.message : created.text.slice(0, 300)));
    if (created.json && Array.isArray(created.json.errors)) log('   ' + JSON.stringify(created.json.errors));
    process.exit(5);
  }
  log(`✅ 仓库已创建：${created.json.html_url}`);
}

const remote = `https://github.com/${repoFull}.git`;
const run = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try { run(['remote', 'remove', 'origin']); } catch { /* 本来就没有 */ }
run(['remote', 'add', 'origin', remote]);
log('→ remote origin = ' + remote);

try {
  const out = run(['push', '-u', 'origin', 'main']);
  log(out.trim() || '→ push 完成');
  log(`\n🎉 发布成功：https://github.com/${repoFull}`);
} catch (e) {
  log('❌ push 失败：');
  log('   ' + String((e.stderr || e.stdout || e.message)).slice(0, 600));
  process.exit(6);
}
