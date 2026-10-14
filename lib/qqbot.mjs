/**
 * QQ 机器人的体检与重启。
 *
 * 为什么单独一个模块：
 *   2026-10-14 老板的机器人"看着在跑、实际收不到消息"。查出来是
 *   **计划任务的启动器被终止后，机器人变成了孤儿进程** ——
 *   TCP 连接还显示 Established，其实早就废了，而且没有任何机制会重启它。
 *   所以"体检"里最要紧的一项就是**父进程还在不在**（孤儿 = 计划任务管不到它了）。
 *
 * ⚠️ 进程匹配的铁律：必须用**结构特征**，不能用业务关键词。
 *   曾经用 `CommandLine -like '*--profile qqbot*'` 匹配，结果把**运行我自己命令的
 *   子进程**也匹配进去了（它的命令行里包含我脚本的全文），把自己杀掉，
 *   报 `Windows Job runner exited with exit code 4294967295`。
 *   所以这里显式排除 `dsh-subprocess`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runPsJson, runPs } from './ps.mjs';
import { paths } from './paths.mjs';

/** QQ 开放平台的资料页（改昵称/头像的地方 —— 这块腾讯没开放 API，只能去控制台） */
export const CONSOLE_URL = 'https://q.qq.com/#/';
export const TASK_NAME = 'DSH-QQBot';

const LOG_FILE = () => path.join(paths.home, 'tools', 'qqbot.log');

/** 日志新鲜度 */
function logInfo() {
  try {
    const st = fs.statSync(LOG_FILE());
    return { size: st.size, mtime: st.mtime.toISOString(), ageMin: Math.round((Date.now() - st.mtimeMs) / 60000) };
  } catch { return { size: 0, mtime: null, ageMin: null }; }
}

/**
 * 一次 PowerShell 调用拿到所有体检数据。
 *
 * 为什么合并：拆成 4 次（找进程 / 查父进程 / 查连接 / 查任务）时，
 * 每次都要启动一个 PowerShell（约 1.5 秒），`/dsh-m/state` 实测要 **6.7 秒** ——
 * 界面每刷新一次就卡这么久。合并成一次后只启动一个进程。
 */
async function probe() {
  const script = `
    $me = ${process.pid}
    $bots = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -like '*--profile qqbot*' -and
        $_.CommandLine -notlike '*dsh-subprocess*' -and
        $_.ProcessId -ne $me
      })
    $bot = if ($bots.Count -gt 0) { $bots[0] } else { $null }
    $out = [ordered]@{ hasBot = [bool]$bot }
    if ($bot) {
      $out.pid = [int]$bot.ProcessId
      $out.ppid = [int]$bot.ParentProcessId
      $out.memMB = [int]($bot.WorkingSetSize / 1MB)
      $out.started = [string]$bot.CreationDate
      $out.parentAlive = [bool](Get-CimInstance Win32_Process -Filter "ProcessId=$($bot.ParentProcessId)" -ErrorAction SilentlyContinue)
      $conns = @(Get-NetTCPConnection -OwningProcess $bot.ProcessId -State Established -ErrorAction SilentlyContinue)
      $out.connCount = [int]$conns.Count
      $out.remotes = @($conns | ForEach-Object { "$($_.RemoteAddress):$($_.RemotePort)" })
    }
    $t = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue
    $i = Get-ScheduledTaskInfo -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue
    $out.taskState = if ($t) { [string]$t.State } else { 'NotFound' }
    $out.taskResult = if ($i) { [int64]$i.LastTaskResult } else { $null }
    $out.taskLastRun = if ($i) { [string]$i.LastRunTime } else { $null }
    $out | ConvertTo-Json -Compress
  `;
  const r = await runPsJson(script, { timeoutMs: 40000 });
  if (!r.ok || !r.data) return { ok: false, error: r.error || 'PowerShell 没返回数据' };
  return { ok: true, data: r.data };
}

// 短缓存：界面一次操作会连着请求两次 state（动作前 load + 动作后返回 state），
// 没有缓存就要跑两遍 PowerShell。20 秒足够新鲜，又省掉重复开销。
let _cache = null;
let _cacheAt = 0;
const CACHE_MS = Number(process.env.DSH_M_QQBOT_TTL_MS || 60000);

/**
 * 完整体检。
 * @param {{fresh?:boolean}} opts fresh=true 时忽略缓存（重启后用）
 */
export async function botHealth({ fresh = false } = {}) {
  if (!fresh && _cache && Date.now() - _cacheAt < CACHE_MS) return _cache;

  const p = await probe();
  const log = logInfo();
  if (!p.ok) {
    const r = { verdict: 'bad', reasons: ['查询失败：' + p.error], proc: null, orphan: false, gateway: { count: 0, remotes: [] }, task: { state: 'Unknown' }, log, error: p.error };
    _cache = r; _cacheAt = Date.now();
    return r;
  }
  const d = p.data;
  const task = { state: d.taskState, lastResult: d.taskResult, lastRun: d.taskLastRun, error: null };

  if (!d.hasBot) {
    const r = {
      verdict: 'bad',
      reasons: ['机器人进程不在了。计划任务应该会自动拉起它；没有的话点「重启机器人」。'],
      proc: null, orphan: false, gateway: { count: 0, remotes: [] }, task, log,
    };
    _cache = r; _cacheAt = Date.now();
    return r;
  }

  const reasons = [];
  const notes = [];
  const orphan = !d.parentAlive;
  const gateway = { count: d.connCount || 0, remotes: d.remotes || [], error: null };

  // ⚠️ 重要更正（2026-10-15 实测，v0.1.9）：
  //   第一版把「父进程不在」当成故障判据 —— **这是错的**。
  //   `qqbot-run.cmd` 的启动器（cmd.exe）**每次都会在拉起机器人后退出**
  //   （计划任务返回码 0xC000013A = 被终止），所以**孤儿是常态**。
  //   实测：父进程不在、网关连接正常、日志正常 —— 机器人是**健康**的。
  //
  //   2026-10-14 那次真故障的判据是「进程僵死（内存 27 MB、CPU 十几分钟不动）+
  //   **日志完全不增长**」—— 不是父进程。当时我误把孤儿当成了病因。
  //
  //   现在：**只有「网关没连上」才算 bad**。孤儿只作为提示。
  if (orphan) {
    notes.push('父进程（启动器）已退出 —— 这是**常态**，启动器拉起机器人后就会退出。' +
      '含义：计划任务不会再自动重启它，真挂了要手动点「重启机器人」。');
  }
  if (gateway.count === 0) reasons.push('没有任何已建立的 TCP 连接 —— 网关断了，消息收不到');

  const verdict = gateway.count === 0 ? 'bad' : 'ok';
  if (!reasons.length) reasons.push('进程在、网关连着');

  const r = {
    verdict, reasons, notes, orphan,
    proc: { pid: d.pid, ppid: d.ppid, memMB: d.memMB, started: psDate(d.started) },
    gateway, task, log,
  };
  _cache = r; _cacheAt = Date.now();
  return r;
}

/** 把 PowerShell 序列化出来的 "/Date(毫秒)/" 或 Date 对象转成本地可读时间 */
function psDate(v) {
  if (!v) return '-';
  const s = String(v);
  const m = /\/Date\((\d+)\)\//.exec(s);
  const ms = m ? Number(m[1]) : Date.parse(s);
  if (!Number.isFinite(ms)) return s;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 重启：先杀掉旧进程，再用计划任务拉起来（这样任务重新接管它） */
export async function restartBot() {
  const before = await botHealth({ fresh: true });
  const killed = [];
  if (before.proc) {
    // 只杀体检确认过的那个 PID，且再确认一次命令行（防止 PID 被复用）
    const chk = await runPsJson(
      `@(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(before.proc.pid)}" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -like '*--profile qqbot*' -and $_.CommandLine -notlike '*dsh-subprocess*' } |
          Select-Object ProcessId) | ConvertTo-Json -Compress`, { timeoutMs: 20000 });
    const arr = chk.ok && chk.data ? (Array.isArray(chk.data) ? chk.data : [chk.data]) : [];
    if (arr.length) {
      const kill = await runPs(`Stop-Process -Id ${Number(before.proc.pid)} -Force -ErrorAction SilentlyContinue`, { timeoutMs: 20000 });
      killed.push(before.proc.pid);
      if (!kill.ok) return { ok: false, error: '停止旧进程失败：' + (kill.stderr || kill.error) };
    } else {
      return { ok: false, error: 'PID 校验没通过（命令行对不上），为安全起见不动它。请人工确认。' };
    }
  }

  // 计划任务负责拉起 + 后续接管
  const start = await runPs(`Start-ScheduledTask -TaskName '${TASK_NAME}'`, { timeoutMs: 25000 });
  if (!start.ok && start.stderr) return { ok: false, error: '启动计划任务失败：' + start.stderr, killed };

  // 等它起来并连上网关
  await new Promise((r) => setTimeout(r, 18000));
  const after = await botHealth({ fresh: true });
  return { ok: after.verdict !== 'bad', killed, before: before.proc, after };
}

/** 给控制中心条目用的元信息（一行行显示给人看） */
export async function botMeta() {
  const h = await botHealth();
  const meta = {};
  if (h.proc) {
    meta['PID'] = String(h.proc.pid);
    // 注意措辞：父进程退出是常态，不要写成"⚠️ 孤儿"吓人
    meta['父进程'] = `${h.proc.ppid}${h.orphan ? '（启动器已退出 · 常态）' : '（还在）'}`;
    meta['内存'] = h.proc.memMB + ' MB';
    meta['启动时间'] = h.proc.started;
    meta['网关连接'] = h.gateway.count ? `${h.gateway.count} 条 · ${h.gateway.remotes.join(', ')}` : '⚠️ 没有（收不到消息）';
  } else {
    meta['状态'] = '⚠️ 进程不在';
  }
  meta['计划任务'] = `${h.task.state}${h.task.lastResult !== null && h.task.lastResult !== undefined ? '（返回码 ' + h.task.lastResult + '）' : ''}`;
  meta['日志'] = h.log.mtime ? `${h.log.size} 字节 · ${h.log.ageMin} 分钟前` : '(读不到)';
  return { meta, health: h.verdict, healthText: h.reasons[0] || '', health_reasons: h.reasons, notes: h.notes || [] };
}
