/**
 * 汇总层：把各采集器拼成一份完整状态，并把界面来的操作分发下去。
 *
 * 设计要点：**每个采集器独立 try/catch**。定时任务/进程这类要调 PowerShell 的采集器
 * 在别人的机器上可能因为权限或策略失败 —— 那也只应该让那一块显示错误，
 * 不能让整个控制中心白屏。
 */
import { collectSkills, disableSkill, enableSkill, deleteSkill } from './collectors/skills.mjs';
import { collectPlugins, enablePlugin, disablePlugin } from './collectors/plugins.mjs';
import { collectProviders } from './collectors/providers.mjs';
import { collectTasks, collectProcesses, taskAction } from './collectors/runtime.mjs';
import { collectSessions, deleteSession } from './collectors/sessions.mjs';
import { listTrash, restoreFromTrash } from './trash.mjs';
import { botHealth, restartBot, CONSOLE_URL } from './qqbot.mjs';
import { paths } from './paths.mjs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export const GROUPS = [
  { key: 'skills', zh: '技能', desc: '给模型看的"使用说明书"。停用后模型这一轮就看不到它了。' },
  { key: 'plugins', zh: '插件', desc: '给 DSH 加功能的包。停用需要重启应用才生效。' },
  { key: 'providers', zh: '模型厂商', desc: '接了哪些模型厂商、各自有哪些模型、密钥（打码显示）。' },
  { key: 'tasks', zh: '定时任务', desc: 'Windows 计划任务：到点自动做事，比如定时抓取额度。' },
  { key: 'processes', zh: '常驻进程', desc: '现在正在跑的 DSH 相关进程。' },
  { key: 'sessions', zh: '会话记录', desc: '对话记录占的磁盘空间，可以清理旧的。' },
];

async function safely(name, fn) {
  try { return { name, ok: true, value: await fn() }; }
  catch (e) { return { name, ok: false, error: String((e && e.message) || e) }; }
}

/** 采集全部；返回 { generatedAt, groups: {...}, errors: [...] } */
export async function collectAll() {
  const [skills, plugins, providers, tasks, processes, sessions] = await Promise.all([
    safely('skills', async () => collectSkills()),
    safely('plugins', async () => collectPlugins()),
    safely('providers', async () => collectProviders()),
    safely('tasks', () => collectTasks()),
    safely('processes', () => collectProcesses()),
    safely('sessions', async () => collectSessions()),
  ]);

  const errors = [];
  const bucket = {};
  for (const r of [skills, plugins, providers, tasks, processes, sessions]) {
    if (!r.ok) { errors.push({ group: r.name, error: r.error }); bucket[r.name] = []; continue; }
    if (r.value && Array.isArray(r.value.items)) {
      bucket[r.name] = r.value.items;
      if (r.value.error) errors.push({ group: r.name, error: r.value.error });
    } else if (Array.isArray(r.value)) {
      bucket[r.name] = r.value;
    } else {
      bucket[r.name] = [];
    }
  }

  // 会话总量单列，便于界面顶部展示
  const sessionTotal = (sessions.ok && sessions.value && sessions.value.total) || null;

  return {
    generatedAt: new Date().toISOString(),
    home: paths.home,
    groups: GROUPS.map((g) => ({
      ...g,
      count: (bucket[g.key] || []).length,
      enabledCount: (bucket[g.key] || []).filter((x) => x.enabled).length,
    })),
    items: bucket,
    sessionTotal,
    trash: listTrash().slice(0, 50),
    errors,
  };
}

/** 在文件管理器里打开某个路径。只允许 DSH 家目录内的路径，避免被当成任意路径打开器。 */
export function openPath(target) {
  if (!target) throw new Error('缺少要打开的路径');
  const resolved = path.resolve(String(target));
  const home = path.resolve(paths.home);
  if (!resolved.startsWith(home)) throw new Error('只允许打开 DSH 家目录内的路径');
  if (!fs.existsSync(resolved)) throw new Error('路径不存在：' + resolved);
  // explorer.exe 打开成功时返回码也可能是 1，所以不检查退出码
  execFile('explorer.exe', [resolved], { windowsHide: false }, () => {});
  return { ok: true, opened: resolved };
}

/** 执行一个操作。payload: { group, action, id, profile, path } */
export async function performAction({ group, action, id, profile, path: targetPath }) {
  const act = String(action || '');
  // 支持 "task-run:DSH-QQBot" 这种带参数的写法
  const [verb, arg] = act.split(':');

  if (verb === 'open') return openPath(targetPath);
  if (verb === 'task-run' || verb === 'task-stop' || verb === 'task-enable' || verb === 'task-disable') {
    return taskAction(arg || id, verb);
  }
  if (verb === 'restore') return restoreFromTrash(id);

  // ── QQ 机器人专用动作（实现见 lib/qqbot.mjs）──
  // 为什么要有这几个：2026-10-14 机器人"看着在跑、实际收不到消息"，
  // 根因是启动器被终止后它成了孤儿进程。以前只能靠命令行排查，现在界面上点。
  if (verb === 'qqbot-health') {
    const h = await botHealth({ fresh: true });
    const icon = h.verdict === 'ok' ? '✅ ' : '🚨 ';
    const note = (h.notes && h.notes.length) ? ' —— ' + h.notes[0] : '';
    // ⚠️「体检」是**查询**不是修改：即使查出问题也要返回 ok:true，
    //    否则客户端会当成"操作失败"，把查到的结论盖掉。结论放在 message 里。
    return { ok: true, verdict: h.verdict, message: icon + h.reasons.join('；') + note, detail: h };
  }
  if (verb === 'qqbot-console') {
    // 改昵称/头像**只能**在 QQ 开放平台控制台做（腾讯没开放 API，每次改都要过审），
    // 所以这里做的是"一键跳到那个页面"。
    // DSH_M_NO_OPEN=1 时不真的打开浏览器 —— 测试否则会弹窗口。
    if (process.env.DSH_M_NO_OPEN !== '1') {
      execFile('explorer.exe', [CONSOLE_URL], { windowsHide: false }, () => {});
    }
    return { ok: true, url: CONSOLE_URL, message: '已打开 QQ 开放平台 —— 机器人资料（昵称/头像）在那里改，改完要过审' };
  }
  if (verb === 'qqbot-restart') {
    const r = await restartBot();
    // ⚠️ 失败必须 throw —— 返回 {ok:false} 的话 index.js 会把它包成 {ok:true,result}，
    //    界面就会当成"成功"弹绿条，把失败盖住。
    if (!r.ok) throw new Error(r.error || '重启失败');
    const a = r.after || {};
    return {
      ok: true,
      message: `已重启${r.killed && r.killed.length ? '（停掉旧进程 ' + r.killed.join(', ') + '）' : ''}；现在：` +
        (a.proc ? `PID ${a.proc.pid}，网关 ${a.gateway && a.gateway.count ? a.gateway.count + ' 条连接' : '⚠️ 没连上'}` : '⚠️ 进程没起来'),
      detail: r,
    };
  }

  switch (group) {
    case 'skills':
      if (verb === 'disable') return disableSkill(id);
      if (verb === 'enable') return enableSkill(id);
      if (verb === 'delete') return deleteSkill(id);
      break;
    case 'plugins':
      if (verb === 'enable') return enablePlugin(profile, id.split('/').slice(1).join('/') || id);
      if (verb === 'disable') return disablePlugin(profile, id.split('/').slice(1).join('/') || id);
      break;
    case 'sessions':
      if (verb === 'delete-session' || verb === 'delete') return deleteSession(id);
      break;
    default:
      break;
  }
  throw new Error(`不支持的操作：${group} / ${action}`);
}
