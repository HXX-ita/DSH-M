/**
 * 采集器：会话与对话记录
 *
 * 结构：<DSH_HOME>\sessions\<编码后的工作目录>\<会话 id>\session.v4.jsonl.zstd
 * 这是磁盘上最占地方的东西（单次长会话能到几 MB 的压缩、十几 MB 的原文），
 * 也是老板最可能想清的东西。删除一律进回收站，可还原。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, safeStat, humanBytes, dirSize } from '../paths.mjs';
import { moveToTrash } from '../trash.mjs';

/**
 * 目录名形如 `--D-deepseek-Example--` ，还原成可读路径 `D:\Example\MyFolder`。
 *
 * ⚠️ 这是**尽力而为**的还原，不是严格逆运算：DSH 把 `:` 和 `\` 都编码成了 `-`，
 * 所以本来叫 `a-b` 的文件夹和 `a\b` 的路径长得一样，无法区分。
 * 界面上只当"提示"用，真正的路径以 meta 里的原目录名为准。
 */
export function decodeProjectDir(name) {
  const m = /^--(.*)--$/.exec(name);
  if (!m) return name;
  const body = m[1];
  const drive = /^([A-Za-z])-(.*)$/.exec(body);
  if (drive) return `${drive[1].toUpperCase()}:\\` + drive[2].replace(/-/g, '\\');
  return body.replace(/-/g, '\\');
}

export function collectSessions() {
  const items = [];
  let root = [];
  try { root = fs.readdirSync(paths.sessionsDir, { withFileTypes: true }).filter((d) => d.isDirectory()); }
  catch { return { items, error: '会话目录不存在: ' + paths.sessionsDir, total: null }; }

  let totalBytes = 0, totalCount = 0;

  for (const proj of root) {
    const projDir = path.join(paths.sessionsDir, proj.name);
    let sessions = [];
    try { sessions = fs.readdirSync(projDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }

    for (const s of sessions) {
      const dir = path.join(projDir, s.name);
      const size = dirSize(dir, 5000);
      const st = safeStat(dir);
      // 找主记录文件
      let main = null, mainSize = 0;
      try {
        for (const f of fs.readdirSync(dir)) {
          const fs2 = safeStat(path.join(dir, f));
          if (fs2 && fs2.size > mainSize) { main = f; mainSize = fs2.size; }
        }
      } catch { /* ignore */ }
      totalBytes += size.bytes; totalCount++;

      const idleDays = st ? Math.floor((Date.now() - st.mtimeMs) / 86400000) : null;
      items.push({
        group: 'sessions',
        id: `${proj.name}/${s.name}`,
        title: s.name.length > 20 ? s.name.slice(0, 8) + '…' + s.name.slice(-6) : s.name,
        zh: `工作目录「${decodeProjectDir(proj.name)}」下的一次对话记录，${size.files} 个文件，${humanBytes(size.bytes)}。` +
            (idleDays !== null && idleDays > 7 ? `已经 ${idleDays} 天没动过。` : ''),
        zhSource: 'curated',
        original: '',
        enabled: true,
        protected: idleDays !== null && idleDays < 1,   // 24 小时内动过的：可能是当前会话，默认保护
        health: 'ok',
        healthText: idleDays !== null && idleDays < 1 ? '最近在使用（很可能就是当前对话）' : '',
        path: dir,
        mtime: st ? st.mtime.toISOString() : null,
        bytes: size.bytes,
        meta: {
          '工作目录': decodeProjectDir(proj.name),
          '会话 id': s.name,
          '占用': humanBytes(size.bytes),
          '文件数': String(size.files),
          '最后活动': st ? new Date(st.mtime).toLocaleString() : '-',
          '主要文件': main ? `${main}（${humanBytes(mainSize)}）` : '-',
        },
        actions: ['delete-session', 'open'],
      });
    }
  }

  return {
    items: items.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || '')),
    total: { bytes: totalBytes, count: totalCount, text: `${totalCount} 个会话，共 ${humanBytes(totalBytes)}` },
    error: null,
  };
}

export function deleteSession(relId) {
  const [proj, sid] = String(relId).split('/');
  if (!proj || !sid) throw new Error('会话 id 格式不对: ' + relId);
  const dir = path.join(paths.sessionsDir, proj, sid);
  if (!fs.existsSync(dir)) throw new Error('找不到这个会话: ' + dir);
  const e = moveToTrash(dir, `会话 ${sid}`);
  return { ok: true, trashed: e.stored, restore: '可在「回收站」里还原' };
}
