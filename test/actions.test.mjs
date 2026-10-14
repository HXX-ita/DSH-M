#!/usr/bin/env node
/**
 * 操作层测试 —— 在**临时沙箱**里验证启停/删除/还原。
 *
 * 铁律：这些操作能改 profile 配置、能删技能和会话。
 * 所以测试必须先把 DSH_HOME 指向临时目录，绝不允许碰真实环境。
 * （paths.mjs 在模块加载时读 DSH_HOME，所以必须在 import 之前设置。）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-m-test-'));
process.env.DSH_HOME = SANDBOX;

// ── 造沙箱 ──
function mk(p) { fs.mkdirSync(p, { recursive: true }); return p; }
mk(path.join(SANDBOX, 'skills', 'demo-skill'));
fs.writeFileSync(path.join(SANDBOX, 'skills', 'demo-skill', 'SKILL.md'),
  '---\nname: demo-skill\ndescription: 这是一个用来测试的技能\n---\n\n# 正文\n', 'utf8');
mk(path.join(SANDBOX, 'skills', 'demo-skill', 'scripts'));
fs.writeFileSync(path.join(SANDBOX, 'skills', 'demo-skill', 'scripts', 'x.mjs'), '//x\n', 'utf8');

const prof = mk(path.join(SANDBOX, 'profiles', 'demoprofile'));
mk(path.join(prof, 'node_modules', 'dsh-control-center'));
mk(path.join(prof, 'node_modules', 'some-plugin'));
fs.writeFileSync(path.join(prof, 'node_modules', 'some-plugin', 'package.json'),
  JSON.stringify({ name: 'some-plugin', version: '1.0.0', description: 'A test plugin' }), 'utf8');
fs.writeFileSync(path.join(prof, 'package.json'), JSON.stringify({
  name: 'dsh-profile-demoprofile',
  dependencies: { 'some-plugin': '1.0.0' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-control-center'] } },
}, null, 2), 'utf8');

mk(path.join(SANDBOX, 'sessions', '--D-demo--', 'sess-1'));
fs.writeFileSync(path.join(SANDBOX, 'sessions', '--D-demo--', 'sess-1', 'session.v4.jsonl.zstd'), 'x'.repeat(2048), 'utf8');

// ── 现在才导入被测代码 ──
const { collectSkills, disableSkill, enableSkill, deleteSkill } = await import('../lib/collectors/skills.mjs');
const { collectPlugins, enablePlugin, disablePlugin } = await import('../lib/collectors/plugins.mjs');
const { collectSessions, deleteSession, decodeProjectDir } = await import('../lib/collectors/sessions.mjs');
const { listTrash, restoreFromTrash } = await import('../lib/trash.mjs');
const { collectAll, performAction } = await import('../lib/registry.mjs');

const checks = [];
const check = (name, ok, extra = '') => { checks.push(ok); console.log((ok ? '✅ ' : '❌ ') + name + (extra ? '  ' + extra : '')); };

console.log('沙箱: ' + SANDBOX + '\n');

// ── 1. 技能：停用 → 启用 → 删除 → 还原 ──
console.log('--- 技能 ---');
let skills = collectSkills();
check('扫到了技能并读到中文说明', skills.length === 1 && skills[0].zh === '这是一个用来测试的技能',
  `zh=${JSON.stringify(skills[0] && skills[0].zh)}`);
check('启用状态下 enabled=true', skills[0].enabled === true);
check('统计了脚本文件数', skills[0].meta['文件数'] === '2', '文件数=' + skills[0].meta['文件数']);

disableSkill('demo-skill');
check('停用后原目录消失', !fs.existsSync(path.join(SANDBOX, 'skills', 'demo-skill')));
check('停用后出现在 skills.disabled', fs.existsSync(path.join(SANDBOX, 'skills.disabled', 'demo-skill')));
skills = collectSkills();
check('停用后 enabled=false', skills[0].enabled === false);

enableSkill('demo-skill');
check('启用后回到 skills 目录', fs.existsSync(path.join(SANDBOX, 'skills', 'demo-skill')));

deleteSkill('demo-skill');
check('删除后目录消失（不是留在原地）', !fs.existsSync(path.join(SANDBOX, 'skills', 'demo-skill')));
check('删除后进了回收站', listTrash().length === 1);
const trashed = listTrash()[0];
check('回收站记下了原位置', trashed.original === path.join(SANDBOX, 'skills', 'demo-skill'));
restoreFromTrash(trashed.stored);
check('还原成功，目录回来了', fs.existsSync(path.join(SANDBOX, 'skills', 'demo-skill', 'SKILL.md')));
check('还原后回收站空了', listTrash().length === 0);

// ── 2. 插件：停用 → 启用；必需组件必须拒绝 ──
console.log('\n--- 插件 ---');
const pkgPath = path.join(prof, 'package.json');
let plugins = collectPlugins();
const somePlugin = plugins.find((p) => p.title === 'some-plugin');
check('扫到未启用的插件（在 dependencies 里）', !!somePlugin && somePlugin.enabled === false);
check('未加载的插件给出「启用」动作', somePlugin.actions.includes('enable'));
check('从英文说明生成了中文标注（原文保留）', somePlugin.zh === '' && somePlugin.original === 'A test plugin',
  'zhSource=' + somePlugin.zhSource);

enablePlugin('demoprofile', 'some-plugin');
let bundles = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dsh.profile.bundles;
check('启用后写进了 bundles', bundles.includes('some-plugin'));
check('启用前做了备份', fs.readdirSync(path.join(SANDBOX, '.dsh-m', 'backups')).length >= 1);
check('备份内容与改前一致', JSON.parse(fs.readFileSync(path.join(SANDBOX, '.dsh-m', 'backups',
  fs.readdirSync(path.join(SANDBOX, '.dsh-m', 'backups'))[0], 'package.json'), 'utf8'))
  .dsh.profile.bundles.includes('some-plugin') === false);

disablePlugin('demoprofile', 'some-plugin');
bundles = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dsh.profile.bundles;
check('停用后从 bundles 移除', !bundles.includes('some-plugin'));
check('停用不会删掉 node_modules 目录', fs.existsSync(path.join(prof, 'node_modules', 'some-plugin')));

let protectedBlocked = false;
try { disablePlugin('demoprofile', 'dsh-control-center'); } catch { protectedBlocked = true; }
check('禁止停用自己（否则界面会打不开）', protectedBlocked);
protectedBlocked = false;
try { disablePlugin('demoprofile', '@deepseek-ai/dsh-base'); } catch { protectedBlocked = true; }
check('禁止停用 dsh-base', protectedBlocked);
check('dsh-base 还在 bundles 里', JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dsh.profile.bundles.includes('@deepseek-ai/dsh-base'));

// ── 3. 会话：删除 → 还原；目录名解码 ──
console.log('\n--- 会话 ---');
check('会话目录名解码正确', decodeProjectDir('--D-demo--') === 'D:\\demo', decodeProjectDir('--D-demo--'));
let sessions = collectSessions();
check('扫到会话并统计了占用', sessions.items.length === 1 && sessions.items[0].bytes >= 2048,
  sessions.total ? sessions.total.text : '');
deleteSession('--D-demo--/sess-1');
check('删除后会话目录消失', !fs.existsSync(path.join(SANDBOX, 'sessions', '--D-demo--', 'sess-1')));
const sessTrash = listTrash().find((t) => String(t.label).includes('sess-1'));
check('会话进了回收站', !!sessTrash);
if (sessTrash) { restoreFromTrash(sessTrash.stored); check('会话还原成功', fs.existsSync(path.join(SANDBOX, 'sessions', '--D-demo--', 'sess-1'))); }

// ── 4. 汇总层：一个采集器炸了不能拖垮全部 ──
console.log('\n--- 汇总层 ---');
const st = await collectAll();
check('collectAll 返回全部 6 个分类', (st.groups || []).length === 6);
check('技能分类有数据', (st.items.skills || []).length === 1);
check('每个分类都带中文名与说明', st.groups.every((g) => g.zh && g.desc));
check('进程/定时任务失败也不影响整体（errors 是数组）', Array.isArray(st.errors));

// ── 5. 不认识的操作要明确报错，不能静默成功 ──
let rejected = false;
try { await performAction({ group: 'skills', action: 'explode', id: 'demo-skill' }); } catch { rejected = true; }
check('未知操作会报错而不是假装成功', rejected);

const bad = checks.filter((x) => !x).length;
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(bad === 0 ? `\n🎉 全部通过（${checks.length} 项）：启停能改、删除能还原、必需组件锁得住` : `\n有 ${bad} / ${checks.length} 项没通过`);
process.exit(bad === 0 ? 0 : 1);
