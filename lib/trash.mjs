/**
 * 回收站 —— 所有破坏性操作的第一原则：**永不硬删**。
 *
 * 任何"删除/停用"都是把东西**移动**到 <DSH_HOME>\.dsh-m\trash\<时间戳>\ 下，
 * 并写一份 manifest.json 记录原始位置，所以随时可以还原。
 *
 * 为什么这么做：这个 App 会让老板点按钮就能停用技能/插件。
 * 一次误点不应该造成不可逆的后果 —— 尤其是"停用了某个插件导致界面打不开"这种。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDir } from './paths.mjs';

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 把某个路径移进回收站。label 用于人看。返回 manifest 条目。 */
export function moveToTrash(absPath, label = '') {
  const bucket = path.join(paths.trashDir, stamp());
  ensureDir(bucket);
  const base = path.basename(absPath);
  const dest = path.join(bucket, base);
  fs.renameSync(absPath, dest);

  const entry = {
    at: new Date().toISOString(),
    label: label || base,
    original: absPath,
    stored: dest,
    bucket,
    kind: fs.statSync(dest).isDirectory() ? 'dir' : 'file',
  };
  const mf = path.join(bucket, 'manifest.json');
  const list = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : [];
  list.push(entry);
  fs.writeFileSync(mf, JSON.stringify(list, null, 2), 'utf8');
  return entry;
}

/** 列出回收站内容（最新在前） */
export function listTrash() {
  const out = [];
  let buckets = [];
  try { buckets = fs.readdirSync(paths.trashDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const b of buckets) {
    const mf = path.join(paths.trashDir, b.name, 'manifest.json');
    if (!fs.existsSync(mf)) continue;
    let list = [];
    try { list = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { continue; }
    for (const e of list) out.push({ ...e, bucket: b.name, exists: fs.existsSync(e.stored) });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** 还原一条记录；原位置已存在同名项时拒绝（不覆盖） */
export function restoreFromTrash(storedPath) {
  const buckets = fs.readdirSync(paths.trashDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const b of buckets) {
    const mf = path.join(paths.trashDir, b.name, 'manifest.json');
    if (!fs.existsSync(mf)) continue;
    const list = JSON.parse(fs.readFileSync(mf, 'utf8'));
    const idx = list.findIndex((e) => e.stored === storedPath);
    if (idx < 0) continue;
    const e = list[idx];
    if (!fs.existsSync(e.stored)) throw new Error('回收站里的文件已经不在了: ' + e.stored);
    if (fs.existsSync(e.original)) throw new Error('原位置已存在同名项，拒绝覆盖: ' + e.original);
    ensureDir(path.dirname(e.original));
    fs.renameSync(e.stored, e.original);
    list.splice(idx, 1);
    fs.writeFileSync(mf, JSON.stringify(list, null, 2), 'utf8');
    return e;
  }
  throw new Error('回收站里找不到这条记录');
}

/** 改文件前先备份一份（用于 package.json / cordis.patch.yml 这类就地修改） */
export function backupFile(absPath, tag = '') {
  if (!fs.existsSync(absPath)) return null;
  const dir = path.join(paths.backupsDir, stamp() + (tag ? '-' + tag : ''));
  ensureDir(dir);
  const dest = path.join(dir, path.basename(absPath));
  fs.copyFileSync(absPath, dest);
  return dest;
}
