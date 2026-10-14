/**
 * 中文标注 —— 让老板看得懂每个东西是干什么的。
 *
 * 三级来源，优先级从高到低：
 *   1. 手工词条（CURATED）：确定、免费、不联网
 *   2. 缓存（<DSH_HOME>\.dsh-m\zh-cache.json）：让模型生成过一次就存下来，不重复花钱
 *   3. 原始 description：很多本来就是中文，直接用
 * 三者都没有，就如实标注"还没有中文说明"，而不是编一个。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDir, readJson } from './paths.mjs';

/** 手工词条：内置/常见项的确定中文说明 */
export const CURATED = {
  skill: {
    'browser-cdp': '用浏览器调试协议驱动 Edge/Chrome，代替"看不见屏幕"时的操作：读页面文字、点按钮、填表单、截图，还能把页面上的密钥直接写进本地文件而不经过对话。',
    'credential-safe-edit': '安全地替换配置里的密钥字段（AppSecret / API Key 等）并验证真的能用，全程不回显明文。',
    'diagnose-windows-sandbox-acl': 'Windows 上遇到"沙箱拒绝访问"时的诊断与修复工具：检查目标路径及每一级父目录的权限，并修好它能证明的问题。',
    'dsh-cloud-model-config': '给 DSH 加云端模型厂商（OpenAI 兼容接口），排查"缺凭据 / 配置不生效 / 换模型"这几类问题。',
    'dsh-plugin-authoring': '教怎么写一个 DSH 插件：包结构、服务端接口、Web 界面席位、以及不依赖 pnpm 的手工安装方式。',
    'github-publish': '把东西发到 GitHub 前的交付检查清单：仓库里只放使用者需要的文件、文档里的路径必须和发布包实物一致、别一股 AI 味、改 Release 用 PATCH 别删了重建、发版后必须下载发布包按文档走一遍。',
    'multi-model-ask': '一条命令问任意大模型，并能自动接力：某个模型没额度、被限流或者卡住了，自动换下一个，任务不会停。',
    'office-docx': '读写和检查 Word 文档（.docx）：报告、表格、格式。',
    'office-pptx': '读写和检查 PowerPoint 演示文稿（.pptx）：文字、表格、图片、图表。',
    'office-xlsx': '读写和检查 Excel 表格（.xlsx）：数据、公式、格式、透视分析。',
    'search-first': '动手写之前先搜一圈：GitHub / npm（DSH 插件市场）/ PyPI / 本机已装包，看有没有现成的。含一条命令的搜索工具（search-tools.mjs）和 DSH 插件生态的入口。',
    'standing-orders': '老板的长期约定与禁区（不要主动写总结、可直接调用其他模型、保留脚本、只做 Windows、别动 C 盘等）。',
  },
  plugin: {
    'dsh-usage-dashboard': '用量看板：显示千问平台免费额度、我方多模型调用用量，以及自动接力的当前状态。',
    'dsh-plugin': 'DSH 社区插件市场：浏览、搜索、安装 10000+ 社区插件，自带中文说明。',
    '@tencent-connect/dsh-qqbot': 'QQ 机器人：把 DSH 接到 QQ 私聊和群聊，手机上就能给电脑下指令。',
    '@deepseek-ai/dsh-base': 'DSH 基础能力包（核心运行时，禁用会导致整个 profile 起不来）。',
    '@deepseek-ai/dsh-web-app': 'DSH 的 Web 界面本体（禁用后就没有这个网页界面了）。',
    'dsh-control-center': '本程序：DSH-M 控制中心，统一管理技能、插件、模型厂商、定时任务、常驻进程和会话记录。',
    '@deepseek-ai/dsh-agent-default-model': '默认模型设置：决定 DSH 平时用哪个厂商的哪个模型。',
    '@deepseek-ai/dsh-llm-pi-ai': '自定义模型厂商接入（OpenAI 兼容），例如千问AI平台云端。',
    '@deepseek-ai/dsh-client-ui-chat': '聊天界面本体。',
    '@deepseek-ai/dsh-client-ui-theme': '主题（深色/浅色）。',
    '@deepseek-ai/dsh-client-ui-settings': '设置页。',
    '@deepseek-ai/dsh-client-ui-settings-account': '账号设置页。',
  },
  task: {
    'DSH-QuotaRefresh': '每 30 分钟自动抓一次千问平台的免费额度，供用量看板显示。',
    'DSH-QQBot': '登录 Windows 后自动把 QQ 机器人跑起来，异常退出会在 1 分钟后自动重启。',
  },
  process: {
    'dsh-desktop': 'DSH 桌面主程序（就是你现在正在用的这个界面，关掉它对话就断了）。',
    'dsh-qqbot': 'QQ 机器人进程（常驻，负责收发 QQ 消息）。',
  },
};

const CACHE_FILE = () => path.join(paths.home, '.dsh-m', 'zh-cache.json');

function loadCache() {
  return readJson(CACHE_FILE(), {}) || {};
}

export function saveZh(kind, id, text, by = 'manual') {
  const cache = loadCache();
  cache[`${kind}:${id}`] = { text, by, at: new Date().toISOString() };
  ensureDir(path.dirname(CACHE_FILE()));
  fs.writeFileSync(CACHE_FILE(), JSON.stringify(cache, null, 2), 'utf8');
  return cache[`${kind}:${id}`];
}

/**
 * 取中文说明。
 * 返回 { text, source }，source ∈ curated | cache | original | none
 */
export function zhFor(kind, id, originalText) {
  const curated = CURATED[kind] && CURATED[kind][id];
  if (curated) return { text: curated, source: 'curated' };

  const cache = loadCache();
  const hit = cache[`${kind}:${id}`];
  if (hit && hit.text) return { text: hit.text, source: hit.by === 'manual' ? 'manual' : 'cache' };

  const orig = String(originalText || '').trim();
  if (!orig) return { text: '', source: 'none' };

  // 原文里有汉字就直接用（很多技能/插件本来就是中文写的）
  if (/[\u4e00-\u9fa5]/.test(orig)) return { text: orig, source: 'original' };

  // 纯英文：如实说明，让界面提示"可以生成中文说明"
  return { text: '', source: 'none', english: orig };
}

/** 需要翻译的条目（供"一键生成中文说明"用） */
export function untranslated(items) {
  return items.filter((it) => it.zhSource === 'none' && (it.english || it.original));
}
