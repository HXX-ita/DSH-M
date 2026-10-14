#!/usr/bin/env node
/**
 * 交叉验证：拿真实配置文件，把 yaml-lite 的结果和 js-yaml 的结果逐字段对比。
 *
 * js-yaml 从 qqbot profile 的 node_modules 里借（desktop profile 没有 YAML 库），
 * 只用于测试，不进产品依赖。**借不到也不影响**：下面还有一组自带的刁钻用例，
 * 所以这个测试在任何机器（包括 CI）上都能真正测东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseYaml } from '../lib/yaml-lite.mjs';

const require = createRequire('D:/deepseek/.dsh/profiles/qqbot/node_modules/');
let jsyaml = null;
try { jsyaml = require('js-yaml'); } catch { /* 没有就跳过真实文件的对比 */ }

// ═══════════ 第一段：自带用例（不依赖任何外部库） ═══════════
// 每一条都是真踩过或差点踩到的形状，不是凑数。
const CASES = [
  ['序列项内联映射（第一版就在这里死循环）',
    '- id: a\n  name: A\n- id: b\n  name: B\n',
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]],

  ['映射 + 更深缩进的序列',
    'providers:\n  p1:\n    models:\n      - id: m1\n        name: M1\n      - id: m2\n',
    { providers: { p1: { models: [{ id: 'm1', name: 'M1' }, { id: 'm2' }] } } }],

  ['空流式数组（DSH 的 cordis.yml 就是它）', '[]\n', []],
  ['空流式对象', '{}\n', {}],
  ['行内流式数组', 'list: [a, b, 3]\n', { list: ['a', 'b', 3] }],
  ['值里带方括号但只是字符串', 'x: "[abc"\n', { x: '[abc' }],

  ['序列项里的空数组',
    '- id: t\n  config:\n    allow: []\n    deny: []\n',
    [{ id: 't', config: { allow: [], deny: [] } }]],

  ['双引号反斜杠续行（真实密钥就是这么存的）',
    '- config:\n    apiKey: "ABCDEF\\\n      GHIJKL"\n',
    [{ config: { apiKey: 'ABCDEFGHIJKL' } }]],

  ['双引号里的普通换行折叠成空格',
    'text: "hello\n  world"\n',
    { text: 'hello world' }],

  ['引号里的 # 不是注释',
    'a: "x # y"\nb: z # 真注释\n',
    { a: 'x # y', b: 'z' }],

  ['整数 / 浮点 / 布尔 / 空',
    'i: 42\nf: 1.5\nt: true\nn: null\nz: ~\n',
    { i: 42, f: 1.5, t: true, n: null, z: null }],

  ["单引号里的两个单引号是一个",
    "a: 'it''s'\n",
    { a: "it's" }],

  ['!!js 标签原样保留不求值',
    'a: !!js Date.now()\n',
    { a: 'Date.now()' }],

  ['三层嵌套 + 注释穿插',
    'a:\n  # 注释\n  b:\n    c: 1\n    d:\n      - x\n      - y\n',
    { a: { b: { c: 1, d: ['x', 'y'] } } }],

  ['同缩进的序列挂在键下（bundles 的常见写法）',
    'dsh:\n  profile:\n    bundles:\n    - one\n    - two\n',
    { dsh: { profile: { bundles: ['one', 'two'] } } }],

  ['顶层就是序列', '- a\n- b\n', ['a', 'b']],
  ['空文件', '\n# 只有注释\n', null],
];

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

let fail = 0, ok = 0;
console.log('── 自带用例（不依赖外部库）──');
for (const [title, text, expected] of CASES) {
  let got;
  try { got = parseYaml(text); } catch (e) { got = { __err: e.message }; }
  if (deepEqual(got, expected)) { ok++; console.log('✅ ' + title); }
  else {
    fail++;
    console.log('❌ ' + title);
    console.log('     期望: ' + JSON.stringify(expected));
    console.log('     实际: ' + JSON.stringify(got));
  }
}

// ═══════════ 第二段：与 js-yaml 对真实配置做交叉验证 ═══════════
const FILES = [
  'D:/deepseek/.dsh/profiles/desktop/cordis.patch.yml',
  'D:/deepseek/.dsh/profiles/desktop/cordis.yml',
  'D:/deepseek/.dsh/profiles/qqbot/cordis.patch.yml',
  'D:/deepseek/.dsh/profiles/qqbot/cordis.yml',
  'D:/deepseek/.dsh/profiles/desktop/node_modules/dsh-usage-dashboard/cordis.patch.yml',
  'D:/deepseek/.dsh/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/cordis.patch.yml',
];

/**
 * 差异路径里如果出现敏感字段名，**绝不打印值**。
 * 教训：第一版直接打印了 <值 vs 值>，把一个 API Key 的前 60 个字符打进了对话记录 ——
 * 这正是我之前定过规矩要避免的事，靠"记得别看"是没用的，必须让代码本身做不到。
 */
const SECRET_KEY = /(key|secret|token|password|passwd|credential|authorization|cookie)/i;

function show(path, v) {
  const last = path.split(/[.[\]]/).filter(Boolean).pop() || '';
  if (SECRET_KEY.test(last)) return `<已打码 长度=${String(v).length}>`;
  return `<${String(v).slice(0, 70)}>`;
}

/** 深比较，返回差异路径列表（只看结构/标量，函数与正则按字符串比） */
function diff(a, b, p = '$', out = []) {
  if (out.length > 40) return out;
  const ta = Object.prototype.toString.call(a);
  const tb = Object.prototype.toString.call(b);
  if (ta !== tb) { out.push(`${p}: 类型不同 ${ta} vs ${tb}`); return out; }
  if (ta === '[object Array]') {
    if (a.length !== b.length) out.push(`${p}: 数组长度 ${a.length} vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${p}[${i}]`, out);
    return out;
  }
  if (ta === '[object Object]') {
    const ka = Object.keys(a), kb = Object.keys(b);
    for (const k of ka) if (!kb.includes(k)) out.push(`${p}.${k}: js-yaml 里没有`);
    for (const k of kb) if (!ka.includes(k)) out.push(`${p}.${k}: yaml-lite 里没有`);
    for (const k of ka) if (kb.includes(k)) diff(a[k], b[k], `${p}.${k}`, out);
    return out;
  }
  if (a !== b) out.push(`${p}: 值不同(len ${String(a).length} vs ${String(b).length}) ${show(p, a)} vs ${show(p, b)}`);
  return out;
}

if (!jsyaml) {
  console.log('\n── 与 js-yaml 对真实配置交叉验证 ──');
  console.log('⏭  本机没有 js-yaml，跳过这段（不影响上面自带用例的结论）。');
  console.log('   想跑这段：在任意 profile 里装上 js-yaml，或改 test/yaml.test.mjs 里的借用路径。');
} else {
console.log('\n── 与 js-yaml 对真实配置交叉验证 ──');
for (const f of FILES) {
  if (!fs.existsSync(f)) { console.log(`⏭  跳过（不存在）: ${path.basename(path.dirname(f))}/${path.basename(f)}`); continue; }
  const text = fs.readFileSync(f, 'utf8');
  const label = f.replace('D:/deepseek/.dsh/profiles/', '');
  let mine, theirs, theirErr = null;
  try { mine = parseYaml(text); } catch (e) { mine = { __err: e.message }; }
  try { theirs = jsyaml.load(text); } catch (e) { theirErr = e.message; }

  if (theirErr) { console.log(`⏭  ${label}  js-yaml 自己都解析失败（${theirErr.slice(0, 50)}），跳过`); continue; }

  const d = diff(mine, theirs);
  if (d.length === 0) { ok++; console.log(`✅ ${label}  与 js-yaml 完全一致`); }
  else {
    fail++;
    console.log(`❌ ${label}  ${d.length} 处不一致:`);
    d.slice(0, 12).forEach((x) => console.log('     ' + x));
  }
}
}

console.log(`\n通过 ${ok} 个，失败 ${fail} 个`);

// ── 打码自检：确认 diff 在任何情况下都不会把密钥打进输出 ──
const SECRET = 'sk-TOP-SECRET-abcdefghijklmnopqrstuvwxyz-0123456789';
const probe = diff({ apiKey: SECRET, name: 'a' }, { apiKey: SECRET + '-x', name: 'b' });
const probeText = probe.join('\n');
const leaked = probeText.includes('TOP-SECRET') || probeText.includes(SECRET.slice(0, 20));
console.log(leaked ? '❌ 打码自检失败：diff 输出了密钥内容' : '✅ 打码自检通过：diff 输出里没有任何密钥内容');
if (leaked) { console.log(probeText); fail++; }

process.exit(fail === 0 ? 0 : 1);
