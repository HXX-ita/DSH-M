#!/usr/bin/env node
/**
 * 交叉验证：拿真实配置文件，把 yaml-lite 的结果和 js-yaml 的结果逐字段对比。
 *
 * js-yaml 从 qqbot profile 的 node_modules 里借（desktop profile 没有 YAML 库），
 * 只用于测试，不进产品依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseYaml } from '../lib/yaml-lite.mjs';

const require = createRequire('D:/deepseek/.dsh/profiles/qqbot/node_modules/');
let jsyaml;
try { jsyaml = require('js-yaml'); }
catch (e) { console.error('借不到 js-yaml，跳过交叉验证:', e.message); process.exit(2); }

const FILES = [
  'D:/deepseek/.dsh/profiles/desktop/cordis.patch.yml',
  'D:/deepseek/.dsh/profiles/desktop/cordis.yml',
  'D:/deepseek/.dsh/profiles/qqbot/cordis.patch.yml',
  'D:/deepseek/.dsh/profiles/qqbot/cordis.yml',
  'D:/deepseek/.dsh/profiles/desktop/node_modules/dsh-usage-dashboard/cordis.patch.yml',
  'D:/deepseek/.dsh/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/cordis.patch.yml',
  'D:/deepseek/.dsh/profiles/desktop/package.json'.replace('package.json', 'cordis.yml'),
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

let fail = 0, ok = 0;
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

console.log(`\n通过 ${ok} 个，失败 ${fail} 个`);

// ── 打码自检：确认 diff 在任何情况下都不会把密钥打进输出 ──
const SECRET = 'sk-TOP-SECRET-abcdefghijklmnopqrstuvwxyz-0123456789';
const probe = diff({ apiKey: SECRET, name: 'a' }, { apiKey: SECRET + '-x', name: 'b' });
const probeText = probe.join('\n');
const leaked = probeText.includes('TOP-SECRET') || probeText.includes(SECRET.slice(0, 20));
console.log(leaked ? '❌ 打码自检失败：diff 输出了密钥内容' : '✅ 打码自检通过：diff 输出里没有任何密钥内容');
if (leaked) { console.log(probeText); fail++; }

process.exit(fail === 0 ? 0 : 1);
