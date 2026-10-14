#!/usr/bin/env node
/**
 * 安装 / 卸载 DSH-M 控制中心（不依赖 pnpm —— desktop profile 的 pnpm 存储是坏的）。
 *
 * 用法：
 *   node bin/install.mjs                     装到 desktop profile
 *   node bin/install.mjs --profile qqbot     装到指定 profile
 *   node bin/install.mjs --uninstall         卸载（只从清单里摘掉，目录保留）
 *
 * 做三件事：
 *   1. 把本包复制到 <profile>\node_modules\dsh-control-center\
 *   2. 在 profile 的 package.json 里登记 dependencies 与 dsh.profile.bundles
 *   3. 改前备份 package.json，改后打印如何生效
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
const NAME = PKG.name;

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const profile = opt('profile', 'desktop');
const uninstall = argv.includes('--uninstall');

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profileDir = path.join(HOME, 'profiles', profile);
const pkgPath = path.join(profileDir, 'package.json');
const destDir = path.join(profileDir, 'node_modules', NAME);

if (!fs.existsSync(pkgPath)) {
  console.error(`❌ 找不到 profile：${profileDir}`);
  console.error('   可用 profile：' + (() => {
    try { return fs.readdirSync(path.join(HOME, 'profiles')).join('、'); } catch { return '(读不到)'; }
  })());
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];

const backup = pkgPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(pkgPath, backup);

if (uninstall) {
  delete pkg.dependencies[NAME];
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== NAME);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`✅ 已从 ${profile} 的清单里摘掉 ${NAME}`);
  console.log('   （node_modules 里的目录保留了，要彻底删就手动删 ' + destDir + '）');
  console.log('   备份：' + backup);
  console.log('\n⚠️  重启 DSH 后生效。');
  process.exit(0);
}

// 1. 复制文件（跳过开发用的东西）
const SKIP = new Set(['node_modules', '.git', 'test', '.github']);
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else if (e.isFile()) fs.copyFileSync(a, b);
  }
}
if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
copyDir(SRC, destDir);

// 2. 登记
pkg.dependencies[NAME] = '^' + PKG.version;
if (!pkg.dsh.profile.bundles.includes(NAME)) pkg.dsh.profile.bundles.push(NAME);
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

// 3. 自检
const installed = JSON.parse(fs.readFileSync(path.join(destDir, 'package.json'), 'utf8'));
const okFiles = ['index.js', 'client.js', 'cordis.patch.yml', 'lib/registry.mjs'].every((f) => fs.existsSync(path.join(destDir, f)));

console.log(`✅ ${NAME}@${PKG.version} 已装到 profile「${profile}」`);
console.log('   位置：' + destDir);
console.log('   bundles：' + pkg.dsh.profile.bundles.join(' → '));
console.log('   备份：' + backup);
console.log('   关键文件齐全：' + (okFiles ? '是' : '否 ← 有问题！'));
console.log('');
console.log('⚠️  需要**重启 DSH** 才会加载（插件的服务端代码是启动时读的）。');
console.log('    重启后右侧栏会出现「控制中心」标签。');
if (installed.version !== PKG.version) console.log('   ⚠️ 版本号对不上：' + installed.version);
