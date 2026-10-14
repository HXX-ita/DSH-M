/**
 * DSH-M 控制中心 —— 服务端
 *
 * 把 lib/registry.mjs 采集到的状态暴露成两个 HTTP 路由，并把界面来的操作分发回去：
 *   GET  /dsh-m/state   → 全量状态（技能/插件/厂商/定时任务/进程/会话/回收站）
 *   POST /dsh-m/action  → 执行操作（启停/删除/运行）
 *
 * ⚠️ 关键写法（踩过坑）：webServer 必须**可选注入**。
 * 若写成顶层 `export const inject = ['webServer']`，一旦服务名不匹配，插件会一直等它、
 * 静默不激活、路由注册不上，而且没有任何报错 —— 极难排查。
 * 正确做法是在 apply 内部 `ctx.inject([...], scoped => ...)`。
 *
 * 安全：这是本地管理接口，能停用技能/关插件/删会话记录。
 * 所以 (1) 只接受来自本机的请求；(2) 所有删除都进回收站，永不硬删。
 */
import fs from 'node:fs';
import path from 'node:path';
import { collectAll, performAction } from './lib/registry.mjs';
import { paths, ensureDir } from './lib/paths.mjs';

export const name = 'dsh-m';
export const inject = [];   // 不声明硬依赖；webServer 走可选注入

const STATE_PATH = '/dsh-m/state';
const ACTION_PATH = '/dsh-m/action';

function isLocal(req) {
  const a = (req.socket && (req.socket.remoteAddress || '')) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('127.');
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => { n += c.length; if (n <= limit) chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console;

  // 加载证据：写下标记文件。没有应用控制台时，用它确认插件到底有没有激活。
  try {
    const dir = path.join(paths.home, '.dsh-m');
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'activated.json'),
      JSON.stringify({ at: new Date().toISOString(), home: paths.home, pid: process.pid, hasInject: typeof ctx.inject === 'function' }, null, 2),
      'utf8');
  } catch { /* 写不了不影响功能 */ }

  const stateHandler = async (req, res) => {
    if (!isLocal(req)) return send(res, 403, { ok: false, error: '只允许本机访问' });
    try {
      send(res, 200, { ok: true, ...(await collectAll()) });
    } catch (e) {
      logger.warn?.('[dsh-m] 采集失败: ' + ((e && e.message) || e));
      send(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  };

  const actionHandler = async (req, res) => {
    if (!isLocal(req)) return send(res, 403, { ok: false, error: '只允许本机访问' });
    try {
      let payload = {};
      if (req.method === 'POST') {
        const raw = await readBody(req);
        payload = raw ? JSON.parse(raw) : {};
      } else {
        const u = new URL(req.url, 'http://127.0.0.1');
        payload = Object.fromEntries(u.searchParams.entries());
      }
      if (!payload || !payload.action) return send(res, 400, { ok: false, error: '缺少 action 参数' });
      const result = await performAction(payload);
      logger.info?.(`[dsh-m] ${payload.group || '-'} / ${payload.action} / ${payload.id || '-'} → ok`);
      send(res, 200, { ok: true, result, state: await collectAll() });
    } catch (e) {
      logger.warn?.('[dsh-m] 操作失败: ' + ((e && e.message) || e));
      send(res, 400, { ok: false, error: String((e && e.message) || e) });
    }
  };

  // webServer 可选注入：拿不到就安静跳过，绝不阻塞插件激活
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped && scoped.webServer;
    if (!webServer || typeof webServer.register !== 'function') {
      logger.warn?.('[dsh-m] 本环境没有 webServer，控制中心的路由没注册（其余功能不受影响）');
      return;
    }
    const disposers = [
      webServer.register({ kind: 'exact', path: STATE_PATH, handler: stateHandler }),
      webServer.register({ kind: 'exact', path: ACTION_PATH, handler: actionHandler }),
    ];
    logger.info?.(`[dsh-m] 控制中心已就绪：${STATE_PATH} / ${ACTION_PATH}`);

    // ★ 后台预热 QQ 机器人体检。
    //   体检要跑一次 PowerShell（Get-CimInstance + Get-NetTCPConnection + Get-ScheduledTask，
    //   实测冷启动约 4.4 秒），如果等界面第一次请求时才跑，那一次会卡很久。
    //   这里在插件加载时就悄悄跑一遍，把结果放进 60 秒缓存 —— 用户打开面板时就是热的。
    //   **不 await**：预热失败也绝不能影响插件激活。
    import('./lib/qqbot.mjs')
      .then((m) => m.botHealth({ fresh: true }))
      .then((h) => logger.info?.(`[dsh-m] QQ 机器人体检预热完成：${h.verdict}`))
      .catch(() => { /* 没装机器人、或 PowerShell 不可用都无所谓 */ });

    ctx.effect(() => () => { for (const d of disposers) { try { d && d(); } catch { /* ignore */ } } });
  });
}
