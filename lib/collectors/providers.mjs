/**
 * 采集器：模型厂商与密钥（providers）
 *
 * 数据来自各 profile 的 cordis.patch.yml（用自带的 yaml-lite 解析）。
 * ★ 密钥一律打码，只显示后 4 位 —— 这个 App 会让老板截图发人，绝不能把密钥画在屏幕上。
 *   打码是**结构性**的：只有显式识别为密钥的字段才展示尾部，其余敏感字段整体隐藏。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, profileDir, listProfiles, readJson } from '../paths.mjs';
import { parseYaml } from '../yaml-lite.mjs';
import { zhFor } from '../info-zh.mjs';

const SECRET_KEY = /(key|secret|token|password|passwd|credential|authorization|cookie)/i;
const SECRETISH = /^sk-[A-Za-z0-9_\-]{8,}$/;

export function mask(value) {
  const s = String(value ?? '');
  if (!s) return '(空)';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 3)}****${s.slice(-4)}　(共 ${s.length} 位)`;
}

/** 递归走一遍配置，把敏感字段换掉 */
export function redact(node, keyName = '') {
  if (Array.isArray(node)) return node.map((v) => redact(v, keyName));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = redact(v, k);
    return out;
  }
  if (typeof node === 'string' && (SECRET_KEY.test(keyName) || SECRETISH.test(node))) return mask(node);
  return node;
}

function readPatch(file) {
  if (!fs.existsSync(file)) return { entries: [], error: null };
  try {
    const doc = parseYaml(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(doc)) return { entries: [], error: '顶层不是数组（不是合法的 patch 文件）' };
    return { entries: doc, error: null };
  } catch (e) {
    return { entries: [], error: e.message };
  }
}

export function collectProviders() {
  const items = [];

  for (const profile of listProfiles()) {
    const files = [
      { file: path.join(profileDir(profile), 'cordis.patch.yml'), layer: 'profile 自己的覆盖层' },
      { file: path.join(profileDir(profile), 'cordis.yml'), layer: 'profile 根（通常为空）' },
    ];

    for (const { file, layer } of files) {
      const { entries, error } = readPatch(file);
      if (error) {
        items.push({
          group: 'providers', id: `${profile}/${path.basename(file)}`, title: path.basename(file),
          zh: '配置文件解析失败，这一层的内容读不出来。', zhSource: 'curated', original: '',
          profile, enabled: true, protected: false, health: 'bad', healthText: error,
          path: file, meta: { 'profile': profile, '层': layer, '错误': error }, actions: ['open'],
        });
      }

      for (const e of entries || []) {
        // ① 自定义厂商
        const providers = e && e.config && e.config.providers;
        if (providers && typeof providers === 'object') {
          for (const [pid, cfg] of Object.entries(providers)) {
            const models = Array.isArray(cfg && cfg.models) ? cfg.models : [];
            const zh = zhFor('provider', pid, cfg && cfg.displayName);
            items.push({
              group: 'providers',
              id: `${profile}/${e.id}/${pid}`,
              title: (cfg && cfg.displayName) || pid,
              zh: zh.text || `自定义模型厂商「${pid}」，共接入 ${models.length} 个模型。`,
              zhSource: zh.source || 'curated',
              original: (cfg && cfg.displayName) || '',
              profile, enabled: true, protected: false, health: 'ok', healthText: '',
              path: file,
              meta: {
                '厂商标识': pid,
                '接入方式': (cfg && cfg.api) || '-',
                '接口地址': (cfg && cfg.baseURL) || '-',
                '密钥': mask(cfg && cfg.apiKey),
                '模型数': String(models.length),
                '模型': models.map((m) => (m && (m.id || m.name)) || '?').join('、') || '-',
                '所在层': layer,
              },
              actions: ['open'],
            });
          }
        }

        // ② 默认模型（决定 DSH 平时用谁）
        if (e && e.id === 'agent-default-model' && e.config) {
          items.push({
            group: 'providers',
            id: `${profile}/agent-default-model`,
            title: '默认模型（DSH 平时用哪个）',
            zh: '决定 DSH 平时对话用哪个厂商的哪个模型。改这里就能换主力模型。',
            zhSource: 'curated', original: '',
            profile, enabled: true, protected: true, health: 'ok', healthText: '',
            path: file,
            meta: {
              '厂商': e.config.provider || '-',
              '模型': e.config.model || '-',
              '思考强度': e.config.reasoningEffort || '(默认)',
              '所在层': layer,
            },
            actions: ['open'],
          });
        }
      }
    }
  }
  return items;
}

/** 只读地取某个 profile 的完整配置（已打码），给界面展开看 */
export function readProfileConfig(profile) {
  const file = path.join(profileDir(profile), 'cordis.patch.yml');
  const { entries, error } = readPatch(file);
  return { file, error, entries: redact(entries) };
}
