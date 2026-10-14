/**
 * yaml-lite —— 够用的 YAML 子集解析器（零依赖）
 *
 * 为什么自己写：DSH 的配置是 cordis.patch.yml，但 desktop profile 和 DSH 运行时里
 * **都没有任何 YAML 库**（只有 qqbot profile 因为 dsh-qqbot 的依赖才带 js-yaml），
 * 而 desktop profile 的 pnpm 存储坏了，装不了新依赖。所以只能自带。
 *
 * 只实现 DSH 配置文件实际会用到的部分：
 *   - 块序列  `- item`
 *   - 块映射  `key: value` / `key:` + 缩进子块
 *   - 标量   纯文本 / 单引号 / 双引号（含 `\` 续行与换行折叠）
 *   - 注释   `#`（引号内的不算）
 *   - `!!js` 标签：原样保留为字符串，不求值
 *
 * 关键技巧：`- key: value`（序列项内联映射）不做特判，而是**把那一行重写成
 * 去掉破折号的等价格式**再交给普通映射解析。少一条代码路径就少一类死循环
 * —— 第一版就是因为特判这条路没走通，`i` 不前进，直接把内存撑爆了。
 *
 * 正确性不靠自信：test/yaml.test.mjs 会拿真实配置文件与 js-yaml 逐字段对比。
 */

const TRUE_WORDS = new Set(['true', 'True', 'TRUE', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', 'False', 'FALSE', 'no', 'off']);
const MAX_STEPS = 200000;   // 兜底：真出现死循环就报错，不要 OOM

function stripComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      out += c;
      if (quote === '"' && c === '\\') { out += line[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += c;
  }
  return out.replace(/\s+$/, '');
}

/** 按顶层分隔符切分（引号/括号内的逗号不算） */
function splitTop(s, sep = ',') {
  const out = [];
  let buf = '';
  let quote = null, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      buf += c;
      if (quote === '"' && c === '\\') { buf += s[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim() !== '') out.push(buf);
  return out;
}

/** 流式集合 `[]` / `{}` / `[a, b]` / `{k: v}`（DSH 的 cordis.yml 就是空的 `[]`） */
export function parseFlow(text) {
  const t = text.trim();
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return splitTop(inner).map((x) => parseScalar(x));
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return {};
    const o = {};
    for (const part of splitTop(inner)) {
      const idx = part.indexOf(':');
      if (idx < 0) continue;
      o[part.slice(0, idx).trim().replace(/^["']|["']$/g, '')] = parseScalar(part.slice(idx + 1));
    }
    return o;
  }
  return undefined;
}

function parseScalar(text) {
  const s = text.trim();
  if (s === '') return null;
  if (s.startsWith('!!js')) return s.slice(4).trim();      // 不求值，保留原文
  const flow = parseFlow(s);
  if (flow !== undefined) return flow;
  if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return parseFloat(s);
  if (s.startsWith("'")) return s.replace(/^'/, '').replace(/'$/, '').replace(/''/g, "'");
  return s;
}

export function parseYaml(text) {
  const lines = String(text).split(/\r?\n/);
  let i = 0;
  let steps = 0;

  const tick = () => { if (++steps > MAX_STEPS) throw new Error('yaml-lite: 解析步数超限（疑似死循环）'); };
  const indentOf = (l) => l.length - l.trimStart().length;
  const isBlankOrComment = (l) => { const t = l.trim(); return t === '' || t.startsWith('#'); };
  const skipBlank = () => { while (i < lines.length && isBlankOrComment(lines[i])) i++; };
  const cur = () => stripComment(lines[i] ?? '').trim();
  const isDash = (t) => t === '-' || t.startsWith('- ');

  /** 读取可能跨行的标量（双引号续行 / 折叠）
   *  约定：进入时 i 已指向"下一行未消费"，返回时也必须停在同一语义上。 */
  function readScalar(startText) {
    let text = startText;
    if (text.trim().startsWith('"')) {
      const unclosed = () => {
        let n = 0;
        for (let k = 0; k < text.length; k++) {
          if (text[k] === '\\') { k++; continue; }
          if (text[k] === '"') n++;
        }
        return n % 2 === 1;
      };
      while (unclosed() && i < lines.length) {
        tick();
        const cont = lines[i];
        i++;                                                   // ← 关键：消费掉，i 要停在下一行
        if (/\\\s*$/.test(text)) text = text.replace(/\\\s*$/, '') + cont.trim();  // 续行：换行吃掉
        else text = text.replace(/\s+$/, '') + ' ' + cont.trim();                 // 普通换行折叠成空格
      }
      const body = text.trim();
      if (body.startsWith('"')) {
        try { return JSON.parse(body); } catch { return body.replace(/^"|"$/g, ''); }
      }
    }
    return parseScalar(text);
  }

  /** 按缩进分派：流式集合 / 序列 / 映射 */
  function parseNode(minIndent) {
    skipBlank();
    if (i >= lines.length) return null;
    const ind = indentOf(lines[i]);
    if (ind < minIndent) return null;
    const text = cur();
    const flow = parseFlow(text);
    if (flow !== undefined) { i++; return flow; }              // 整行就是一个流式集合
    return isDash(text) ? parseSequence(ind) : parseMapping(ind);
  }

  function parseSequence(indent) {
    const arr = [];
    for (;;) {
      tick();
      skipBlank();
      if (i >= lines.length) break;
      const line = lines[i];
      if (indentOf(line) !== indent || !isDash(cur())) break;

      const text = cur();
      const rest = text === '-' ? '' : text.slice(2).trim();

      if (rest === '') {
        i++;
        arr.push(parseNode(indent + 1));
      } else if (/^[^:\s][^:]*\s*:(\s|$)/.test(rest)) {
        // 序列项内联映射：改写成"去掉破折号"的等价格式，交回普通映射解析
        lines[i] = ' '.repeat(indent + 2) + rest;
        arr.push(parseNode(indent + 2));
      } else {
        i++;
        arr.push(readScalar(rest));
      }
    }
    return arr;
  }

  function parseMapping(indent) {
    const obj = {};
    for (;;) {
      tick();
      skipBlank();
      if (i >= lines.length) break;
      const line = lines[i];
      const ind = indentOf(line);
      const text = cur();
      if (ind !== indent) break;          // 更深/更浅都交给调用者
      if (isDash(text)) break;            // 序列，交给 parseSequence

      const m = /^([^:]+?)\s*:(?:\s+(.*))?$/.exec(text);
      if (!m) break;                      // 不是键值对

      const key = m[1].trim().replace(/^["']|["']$/g, '');
      const valueText = m[2] === undefined ? '' : m[2];
      i++;

      if (valueText.trim() === '') {
        skipBlank();
        if (i < lines.length && indentOf(lines[i]) > indent) obj[key] = parseNode(indent + 1);
        else if (i < lines.length && indentOf(lines[i]) === indent && isDash(cur())) obj[key] = parseSequence(indent);
        else obj[key] = null;
      } else {
        obj[key] = readScalar(valueText);
      }
    }
    return obj;
  }

  skipBlank();
  if (i >= lines.length) return null;
  return parseNode(0);
}

export default { parse: parseYaml };
