/**
 * 采集器：插件（plugins）
 *
 * DSH 一个 profile 装了什么，由两处决定：
 *   1. <profile>\package.json 的 dsh.profile.bundles  —— 被加载的 bundle 列表
 *   2. <profile>\node_modules\<pkg>                    —— 实际装在哪
 * 所以"停用"= 从 bundles 里摘掉（**不是删目录**），改前自动备份 package.json。
 *
 * 自我保护：本程序自己和 dsh-base / dsh-web-app 一律禁止停用 ——
 * 停了本程序就没有这个界面了，属于把自己锁在门外。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, profileDir, listProfiles, readJson, dirSize, humanBytes, ensureDir } from '../paths.mjs';
import { backupFile } from '../trash.mjs';
import { zhFor } from '../info-zh.mjs';

/** 停了会出事的包，永远不许通过界面停用 */
export const PROTECTED = new Set([
  'dsh-control-center',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
]);

function pkgJsonIn(profile, name) {
  const p = path.join(profileDir(profile), 'node_modules', name, 'package.json');
  return readJson(p, null);
}

function collectForProfile(profile) {
  const dir = profileDir(profile);
  const pkgPath = path.join(dir, 'package.json');
  const pkg = readJson(pkgPath, null);
  if (!pkg) return [];

  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  const deps = Object.keys(pkg.dependencies || {});
  const installed = new Set();
  try {
    for (const e of fs.readdirSync(path.join(dir, 'node_modules'), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.name.startsWith('@')) {
        try { for (const s of fs.readdirSync(path.join(dir, 'node_modules', e.name))) installed.add(`${e.name}/${s}`); } catch { /* ignore */ }
      } else if (e.isDirectory()) installed.add(e.name);
    }
  } catch { /* node_modules 不存在也正常 */ }

  const names = [...new Set([...bundles, ...deps, ...installed])].sort();

  return names.map((name) => {
    const meta = pkgJsonIn(profile, name);
    const isBundle = bundles.includes(name);
    const isDep = deps.includes(name);
    // 分三档，避免"依赖的依赖"把列表淹掉（node_modules 里通常有几百个）
    const tier = isBundle ? 'bundle' : (isDep ? 'dependency' : 'transitive');
    const size = fs.existsSync(path.join(dir, 'node_modules', name))
      ? dirSize(path.join(dir, 'node_modules', name), 20000) : { bytes: 0, files: 0 };
    const desc = (meta && meta.description) || '';
    const zh = zhFor('plugin', name, desc);
    const protectedPkg = PROTECTED.has(name);

    return {
      group: 'plugins',
      id: `${profile}/${name}`,
      title: name,
      zh: zh.text,
      zhSource: zh.source,
      original: desc,
      english: zh.english,
      profile,
      tier,
      enabled: isBundle,
      protected: protectedPkg,
      health: meta ? 'ok' : (installed.has(name) ? 'warn' : 'bad'),
      healthText: meta ? '' : (installed.has(name) ? '目录在但读不到 package.json' : '未安装（只在依赖/清单里）'),
      path: path.join(dir, 'node_modules', name),
      meta: {
        '版本': (meta && meta.version) || '-',
        'profile': profile,
        '状态': { bundle: '正在加载', dependency: '已声明依赖（未加载）', transitive: '依赖的依赖（未加载）' }[tier],
        '在 dependencies 里': isDep ? '是' : '否',
        '目录大小': humanBytes(size.bytes),
        '文件数': String(size.files),
        '类型': (meta && meta.dsh && meta.dsh.client) ? '含 Web 界面' : '仅服务端',
      },
      actions: protectedPkg ? ['open']
        : (isBundle ? ['disable', 'open'] : (tier === 'dependency' ? ['enable', 'open'] : ['open'])),
    };
  });
}

export function collectPlugins() {
  const out = [];
  for (const p of listProfiles()) out.push(...collectForProfile(p));
  return out.sort((a, b) => {
    if (a.profile !== b.profile) return a.profile.localeCompare(b.profile);
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

/** 改 profile 的 bundles 列表 */
function setBundle(profile, name, on) {
  const pkgPath = path.join(profileDir(profile), 'package.json');
  const pkg = readJson(pkgPath, null);
  if (!pkg) throw new Error('读不到 profile 的 package.json: ' + pkgPath);
  if (PROTECTED.has(name)) throw new Error(`「${name}」是本程序或 DSH 的必需组件，禁止停用（否则界面会打不开）`);

  // 找一下这个包到底装没装，没装就明说
  const installedPath = path.join(profileDir(profile), 'node_modules', name);
  if (on && !fs.existsSync(installedPath)) {
    throw new Error(`没找到已安装的目录 ${installedPath}，无法启用。请先用插件市场安装。`);
  }

  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  const bundles = new Set(pkg.dsh.profile.bundles || []);
  if (on) bundles.add(name); else bundles.delete(name);
  pkg.dsh.profile.bundles = [...bundles];

  const backup = backupFile(pkgPath, on ? 'enable' : 'disable');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return { ok: true, backup, bundles: pkg.dsh.profile.bundles, restartRequired: true };
}

export function enablePlugin(profile, name) { return setBundle(profile, name, true); }
export function disablePlugin(profile, name) { return setBundle(profile, name, false); }
