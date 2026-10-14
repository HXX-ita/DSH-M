/**
 * 调用 PowerShell 的小工具。
 *
 * 两个必须做的设置：
 *   1. `[Console]::OutputEncoding = UTF8` —— 否则中文输出会按 GBK 出来变乱码
 *   2. `-NoProfile -NonInteractive` —— 不受用户 profile 干扰、不会卡住等输入
 * 并且强制 JSON 输出，Node 这边才不用去解析人类可读的表格。
 */
import { execFile } from 'node:child_process';

const PS = process.env.DSH_M_POWERSHELL ||
  `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

export function runPs(script, { timeoutMs = 20000 } = {}) {
  const full = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${script}`;
  return new Promise((resolve) => {
    execFile(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', full],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
          stdout: (stdout || '').replace(/^\uFEFF/, '').trim(),
          stderr: (stderr || '').trim(),
          error: err ? String(err.message || err) : null,
        });
      });
  });
}

export async function runPsJson(script, opts) {
  const r = await runPs(script, opts);
  if (!r.ok) return { ok: false, error: r.stderr || r.error, data: null };
  if (!r.stdout) return { ok: true, data: null };
  try { return { ok: true, data: JSON.parse(r.stdout) }; }
  catch (e) { return { ok: false, error: 'PowerShell 输出不是合法 JSON: ' + r.stdout.slice(0, 200), data: null }; }
}
