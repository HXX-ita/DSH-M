/**
 * 采集器：技能（skills）
 *
 * DSH 从 <DSH_HOME>\skills\<名字>\SKILL.md 热加载技能；front-matter 里的
 * name/description 会进"技能目录"（模型每轮都能看到 description）。
 * 所以"停用"= 把目录移出 skills\ —— DSH 不扫别的目录，天然就是关掉的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDir, dirSize, humanBytes, safeStat } from '../paths.mjs';
import { moveToTrash } from '../trash.mjs';
import { zhFor } from '../info-zh.mjs';

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/** 解析 SKILL.md 的 front-matter（只需要 name / description 两个单行标量） */
export function parseFrontMatter(text) {
  const m = FRONT_MATTER.exec(text);
  if (!m) return { name: null, description: null, hasFrontMatter: false };
  const out = { name: null, description: null, hasFrontMatter: true };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (kv[1] === 'name') out.name = v;
    if (kv[1] === 'description') out.description = v;
  }
  return out;
}

function scanDir(root, enabled) {
  const items = [];
  if (!fs.existsSync(root)) return items;
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    const skillFile = path.join(dir, 'SKILL.md');
    const st = safeStat(skillFile);
    let fm = { name: null, description: null, hasFrontMatter: false };
    if (st) { try { fm = parseFrontMatter(fs.readFileSync(skillFile, 'utf8')); } catch { /* 读不了就留空 */ } }
    const size = dirSize(dir);
    const zh = zhFor('skill', d.name, fm.description);
    items.push({
      group: 'skills',
      id: d.name,
      title: fm.name || d.name,
      zh: zh.text,
      zhSource: zh.source,
      original: fm.description || '',
      enabled,
      health: st ? (fm.description ? 'ok' : 'warn') : 'bad',
      healthText: st ? (fm.description ? '' : 'SKILL.md 里没有 description，模型看不到它的用途') : '缺少 SKILL.md',
      protected: d.name === 'standing-orders',   // 老板的长期约定，别手滑关掉
      path: dir,
      meta: {
        '目录名': d.name,
        '技能名': fm.name || '(未声明)',
        '文件数': String(size.files),
        '占用': humanBytes(size.bytes),
        '改动时间': st ? new Date(st.mtime).toLocaleString() : '-',
      },
      actions: enabled ? ['disable', 'delete', 'open'] : ['enable', 'delete', 'open'],
    });
  }
  return items;
}

export function collectSkills() {
  const enabledItems = scanDir(paths.skillsDir, true);
  const disabledItems = scanDir(paths.skillsDisabledDir, false);
  return [...enabledItems, ...disabledItems].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

export function disableSkill(id) {
  const src = path.join(paths.skillsDir, id);
  if (!fs.existsSync(src)) throw new Error('技能不存在或已经是停用状态: ' + id);
  ensureDir(paths.skillsDisabledDir);
  const dest = path.join(paths.skillsDisabledDir, id);
  if (fs.existsSync(dest)) throw new Error('停用区已有同名技能，请先处理: ' + dest);
  fs.renameSync(src, dest);
  return { ok: true, moved: `${src} → ${dest}`, note: 'DSH 只扫 skills\\，移到 skills.disabled\\ 即刻生效（技能是热加载的，不用重启）' };
}

export function enableSkill(id) {
  const src = path.join(paths.skillsDisabledDir, id);
  if (!fs.existsSync(src)) throw new Error('停用区里没有这个技能: ' + id);
  ensureDir(paths.skillsDir);
  const dest = path.join(paths.skillsDir, id);
  if (fs.existsSync(dest)) throw new Error('skills\\ 下已有同名技能: ' + dest);
  fs.renameSync(src, dest);
  return { ok: true, moved: `${src} → ${dest}` };
}

export function deleteSkill(id) {
  for (const [dir, where] of [[paths.skillsDir, '启用区'], [paths.skillsDisabledDir, '停用区']]) {
    const p = path.join(dir, id);
    if (fs.existsSync(p)) {
      const e = moveToTrash(p, `技能 ${id}（来自${where}）`);
      return { ok: true, trashed: e.stored, restore: '可在「回收站」里还原' };
    }
  }
  throw new Error('找不到这个技能: ' + id);
}
