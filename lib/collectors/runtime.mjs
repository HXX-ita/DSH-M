/**
 * 采集器：Windows 定时任务 + 常驻进程
 *
 * 为什么要管这两个：老板要的是"一键关掉"。而 DSH 生态里真正"一直在跑"的东西
 * 只有两个来源 —— 计划任务（开机自启 / 定时抓额度）和常驻进程（QQ 机器人）。
 * 关掉它们的正确姿势是操作**计划任务**，而不是粗暴 kill 进程，
 * 否则任务计划会在 1 分钟后把它拉起来（我们就是这么配的）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { zhFor } from '../info-zh.mjs';
import { runPs, runPsJson } from '../ps.mjs';

const DSH_TASK = /^DSH-/i;

export async function collectTasks() {
  const script = `
    $list = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
      $_.TaskName -like 'DSH-*' -or $_.TaskPath -eq '\\\\'
    } | Select-Object -First 300
    $out = foreach ($t in $list) {
      $info = $null
      try { $info = Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction Stop } catch {}
      $act = @($t.Actions) | ForEach-Object { ($_.Execute, $_.Arguments) -join ' ' }
      [pscustomobject]@{
        name    = $t.TaskName
        path    = $t.TaskPath
        state   = [string]$t.State
        action  = ($act -join ' ; ')
        lastRun = if ($info) { [string]$info.LastRunTime } else { '' }
        lastRes = if ($info) { [int]$info.LastTaskResult } else { $null }
        nextRun = if ($info) { [string]$info.NextRunTime } else { '' }
      }
    }
    ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
  `;
  const r = await runPsJson(script, { timeoutMs: 30000 });
  if (!r.ok) return { items: [], error: r.error };

  const rows = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []);
  const items = rows.filter((t) => t && t.name).map((t) => {
    const isDsh = DSH_TASK.test(t.name);
    const zh = zhFor('task', t.name);
    const running = t.state === 'Running';
    const resTxt = t.lastRes === 0 ? '成功' : (t.lastRes === null ? '-' : `返回码 ${t.lastRes}`);
    return {
      group: 'tasks',
      id: t.name,
      title: t.name,
      zh: zh.text || (isDsh ? 'DSH 相关计划任务。' : '系统计划任务（非 DSH 的，请谨慎操作）。'),
      zhSource: zh.source,
      original: '',
      enabled: t.state !== 'Disabled',
      protected: !isDsh,          // 非 DSH 的任务默认不许一键关，避免误伤系统
      health: running ? 'ok' : (t.lastRes === 0 || t.lastRes === null ? 'ok' : 'warn'),
      healthText: running ? '正在运行' : (t.lastRes === 0 ? '' : `上次执行${resTxt}`),
      meta: {
        '状态': t.state === 'Ready' ? '待命（到点会跑）' : (running ? '正在运行' : t.state),
        '上次执行': t.lastRun || '-',
        '上次结果': resTxt,
        '下次执行': t.nextRun || '-',
        '启动什么': t.action || '-',
        '分类': isDsh ? 'DSH 自己的任务' : '系统任务',
      },
      actions: isDsh
        ? (running ? ['task-stop', 'task-run'] : ['task-run', 'task-disable', 'task-enable'])
        : ['task-run'],
    };
  });
  return { items, error: null };
}

export async function taskAction(name, op) {
  const map = {
    'task-run': `Start-ScheduledTask -TaskName '${name.replace(/'/g, "''")}'`,
    'task-stop': `Stop-ScheduledTask -TaskName '${name.replace(/'/g, "''")}'`,
    'task-enable': `Enable-ScheduledTask -TaskName '${name.replace(/'/g, "''")}' | Out-Null`,
    'task-disable': `Disable-ScheduledTask -TaskName '${name.replace(/'/g, "''")}' | Out-Null`,
  };
  const script = map[op];
  if (!script) throw new Error('不支持的定时任务操作: ' + op);
  const r = await runPs(script, { timeoutMs: 30000 });
  if (!r.ok) throw new Error(r.stderr || r.error || 'PowerShell 执行失败');
  return { ok: true, op, task: name };
}

/** 常驻进程：只关心 DSH 自己的，别去列全系统进程 */
export async function collectProcesses() {
  const script = `
    $out = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue |
      ForEach-Object {
        $c = $_.CommandLine
        $role = 'other'
        if     ($c -like '*dsh-subprocess*')        { $role = 'runner' }
        elseif ($c -like '*dsh-desktop-host*cli.js*') { $role = 'cli' }
        elseif ($c -like '*--type=renderer*')        { $role = 'renderer' }
        elseif ($c -like '*--type=gpu*')             { $role = 'gpu' }
        elseif ($c -like '*--type=utility*')         { $role = 'utility' }
        elseif ($c -like '*dsh-desktop-host*')       { $role = 'desktop' }
        elseif ($c -like '*DeepSeek Harness*')       { $role = 'desktop' }
        else                                         { $role = 'node' }
        $prof = ''
        if ($c -match '--profile\\s+([\\w.-]+)') { $prof = $Matches[1] }
        [pscustomobject]@{
          pid    = [int]$_.ProcessId
          parent = [int]$_.ParentProcessId
          name   = $_.Name
          role   = $role
          profile= $prof
          mem    = [int64]$_.WorkingSetSize
          started= [string]$_.CreationDate
        }
      }
    ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
  `;
  const r = await runPsJson(script, { timeoutMs: 30000 });
  if (!r.ok) return { items: [], error: r.error };

  const rows = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []);
  const ROLE_ZH = {
    desktop: 'DSH 桌面主程序（你现在正在用的这个界面的主进程）',
    renderer: '界面渲染进程（负责画窗口，关掉窗口就断了）',
    gpu: '图形加速进程（Electron 正常工作进程）',
    utility: '辅助进程（Electron 正常工作进程）',
    cli: 'dsh 命令行实例',
    runner: '命令运行器（DSH 执行 shell 命令时临时开的，短命，属正常现象）',
    node: 'Node 进程',
    other: 'DSH 进程',
  };
  const items = rows.filter((p) => p && p.pid).map((p) => {
    const isBot = p.role === 'cli' && p.profile === 'qqbot';
    // 一个东西可能有多个进程（主进程 + 渲染 + GPU），标题要能一眼区分
    const LABEL = {
      desktop: 'DSH 桌面主程序', renderer: '界面渲染进程', gpu: '图形加速进程',
      utility: '辅助进程', runner: '命令运行器', cli: 'dsh 命令行实例', node: 'Node 进程', other: 'DSH 进程',
    };
    const id = isBot ? 'dsh-qqbot' : `${p.role}-${p.pid}`;
    const zh = zhFor('process', id);
    return {
      group: 'processes',
      id: String(p.pid),
      title: isBot ? 'QQ 机器人' : `${LABEL[p.role] || p.role} (PID ${p.pid})`,
      zh: zh.text || ROLE_ZH[p.role] || '',
      zhSource: zh.source,
      original: '',
      protected: p.role === 'desktop' || p.role === 'runner',   // 杀桌面=断自己；杀 runner=断当前命令
      enabled: true,
      health: 'ok',
      healthText: p.role === 'runner' ? '临时进程' : '',
      meta: {
        'PID': String(p.pid),
        '父进程': String(p.parent),
        '角色': ROLE_ZH[p.role] || p.role,
        'profile': p.profile || '-',
        '内存': (p.mem / 1024 / 1024).toFixed(0) + ' MB',
        '启动时间': p.started || '-',
      },
      // QQ 机器人走计划任务启停，不要直接 kill；其余进程没有"可打开的位置"，不给按钮
      actions: isBot ? ['task-stop:DSH-QQBot', 'task-run:DSH-QQBot'] : [],
    };
  });
  return { items, error: null };
}
