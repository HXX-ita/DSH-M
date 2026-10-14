/**
 * 统一的路径解析 —— 所有采集器都从这里拿路径，不各自猜。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

export const paths = {
  home: HOME,
  profilesDir: path.join(HOME, 'profiles'),
  skillsDir: path.join(HOME, 'skills'),
  /** 被停用的技能挪到这里（DSH 只扫 skills/，所以兄弟目录是安全的） */
  skillsDisabledDir: path.join(HOME, 'skills.disabled'),
  sessionsDir: path.join(HOME, 'sessions'),
  trashDir: path.join(HOME, '.dsh-m', 'trash'),
  backupsDir: path.join(HOME, '.dsh-m', 'backups'),
  configFile: path.join(HOME, 'dsh-m.config.json'),
};

export function profileDir(name) {
  return path.join(paths.profilesDir, name);
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 列出所有 profile 名（含 desktop） */
export function listProfiles() {
  try {
    return fs.readdirSync(paths.profilesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch { return []; }
}

export function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

export function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/** 递归算目录大小与文件数（跳过软链接/junction，避免绕进别的盘） */
export function dirSize(dir, budget = 200000) {
  let bytes = 0, files = 0, n = 0;
  const walk = (d) => {
    if (n++ > budget) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) { const st = safeStat(full); if (st) { bytes += st.size; files++; } }
    }
  };
  walk(dir);
  return { bytes, files, truncated: n > budget };
}

export function humanBytes(n) {
  if (!Number.isFinite(n)) return '-';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}
