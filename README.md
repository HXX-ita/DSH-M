# DSH-M · DeepSeek Harness 控制中心

> 一个 DSH 插件：在界面右侧栏里，**看得懂、点得动**地管理 DeepSeek Harness 的一切。
> 每一项都有中文说明；开关是按钮；删错了能还原。

[![DSH Plugin](https://img.shields.io/badge/DeepSeek_Harness-plugin-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

---

## 它解决什么问题

用 DeepSeek Harness 的人迟早会问这几个问题：

- 我装了哪些**技能**？哪个在起作用？想临时关掉一个怎么办？
- 我装了哪些**插件**？哪个是必需的、哪个关掉也无所谓？
- 我接了几个**模型厂商**？分别有哪些模型？密钥配好了没？
- 有没有**定时任务**在偷偷跑？**QQ 机器人**现在活着没？
- 对话记录占了**多少磁盘**？哪些可以清？

以前这些都要翻配置文件、敲命令。DSH-M 把它们收进一个界面：

| 分类 | 能看到什么 | 能做什么 |
|---|---|---|
| 技能 | 名称、中文说明、文件数、占用、改动时间 | 启用 / 停用 / 删除 / 打开文件夹 |
| 插件 | 版本、在哪个 profile、是否正在加载、目录大小 | 启用 / 停用 / 打开文件夹 |
| 模型厂商 | 厂商、接口地址、模型清单、**密钥打码显示** | 打开配置 |
| 定时任务 | 状态、上次执行结果、下次时间、启动命令 | 立刻运行 / 停用 / 启用 / 停止 |
| 常驻进程 | 角色（主程序/渲染/GPU/机器人）、内存、启动时间 | 一键启停 QQ 机器人 |
| 会话记录 | 工作目录、占用、最后活动时间 | 删除（进回收站）/ 还原 |

---

## 三个设计原则

### 1. 数据驱动：扫到什么显示什么

**不写死清单。** 分类来自采集器，条目来自文件系统和系统接口。
所以以后新增的技能、插件、定时任务，会自动出现在界面上，不需要改这个程序。

### 2. 永不硬删

所有"删除"都是**移动到回收站**：

```
<DSH_HOME>\.dsh-m\trash\<时间戳>\
```

并写一份 `manifest.json` 记录原始位置，界面上有「回收站」分类可以一键还原。
技能"停用"也不是删除，只是移出 `skills\`（DSH 不扫别的目录，天然生效）。

### 3. 自己锁得住

下面这些**永远不许通过界面停用**（否则你会把自己锁在门外）：

- `dsh-control-center`（本程序自己）
- `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`（DSH 的核心）

它们在界面上带 🔒 标记，按钮是点不动的。

---

## 安装

### 方式一：本仓库直接安装（推荐，不依赖 pnpm）

```bash
git clone https://github.com/HXX-ita/DSH-M.git
cd DSH-M
node bin/install.mjs                      # 装到 desktop profile
node bin/install.mjs --profile qqbot      # 装到别的 profile
node bin/install.mjs --uninstall          # 卸载
```

> 为什么不用 `dsh plugin add`：某些 profile 的 pnpm 存储可能已经损坏
> （`ERR_PNPM_UNEXPECTED_STORE`），而本插件**零运行时依赖**，
> 手工复制文件反而更可靠。

安装脚本会：复制文件 → 在 profile 的 `package.json` 里登记
`dependencies` 与 `dsh.profile.bundles` → **改前自动备份**。

**装完要重启 DSH**（插件的服务端代码是启动时读的）。

### 方式二：插件市场

如果你的 DSH 装了插件市场（`dsh-plugin`），也可以从市场里搜 `dsh-control-center` 安装。

---

## 使用

重启后，右侧栏会出现 **「控制中心」** 标签：

- 顶部分类是**标签按钮**，点一下切换
- 下面是**搜索框**，可以按名字或说明搜
- 每一项是一张卡片：标题 + 一句话中文说明 + 明细 + 操作按钮
- 红色按钮 = 危险操作，点了会**先弹确认框**
- 灰色 🔒 = 必需组件，禁止操作

### 不想开界面也能用

```bash
node bin/dsh-m.mjs collect          # 采集一次，打印各类数量
node bin/dsh-m.mjs collect --full   # 连每条的中文说明一起打印
node bin/dsh-m.mjs collect --json   # 完整 JSON
node bin/dsh-m.mjs action skills disable my-skill
```

---

## 技术说明

### HTTP 接口（仅监听本机）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-m/state` | 全量状态 |
| POST | `/dsh-m/action` | 执行操作，body: `{group, action, id, profile, path}` |

**只接受来自 `127.0.0.1` 的请求**，其他来源一律 403。
所有删除操作都在 `<DSH_HOME>` 内，且都会进回收站。

### 零依赖

本插件**没有任何 npm 运行时依赖** —— 因为它要在别人电脑上装，
而 DSH 的 profile 环境未必能正常安装依赖。为此自带了一个 YAML 子集解析器
（`lib/yaml-lite.mjs`），并用 js-yaml 对真实配置文件做了逐字段交叉验证。

### 测试

```bash
node test/yaml.test.mjs      # YAML 解析器 vs js-yaml，逐字段对比 + 密钥打码自检
node test/actions.test.mjs   # 启停/删除/还原（在临时沙箱里跑，绝不碰真实配置）
node test/plugin.test.mjs    # HTTP 路由、安全守卫、启停链路
```

三个测试都会把 `DSH_HOME` 指向临时目录，**不会修改你的真实环境**。

---

## 已知限制

- **只支持 Windows。** 定时任务和进程采集用的是 Windows 的 PowerShell 接口；
  其他系统上这两类会显示为空并给出提示，其余分类照常工作。
- **插件启停需要重启 DSH。** 这是 DSH 的加载机制决定的，不是本程序的选择。
- **会话目录名的还原是尽力而为。** DSH 把 `:` 和 `\` 都编码成 `-`，
  所以本来叫 `a-b` 的文件夹和 `a\b` 无法区分，界面上只当提示用。
- **不会自动生成中文说明。** 内置词条覆盖常见项；其余显示原文并标注"还没有中文说明"，
  而不是编一个。可以在 `<DSH_HOME>\.dsh-m\zh-cache.json` 里手工补充。

---

## 目录结构

```
DSH-M/
├── index.js                  插件服务端：注册路由、分发操作
├── client.js                 插件界面：右侧栏「控制中心」面板
├── cordis.patch.yml          插件自带的加载补丁
├── bin/
│   ├── install.mjs           安装/卸载（不依赖 pnpm）
│   └── dsh-m.mjs             命令行入口（也是自测入口）
├── lib/
│   ├── yaml-lite.mjs         零依赖 YAML 子集解析器
│   ├── paths.mjs             路径解析
│   ├── trash.mjs             回收站：永不硬删
│   ├── ps.mjs                调 PowerShell 的小工具
│   ├── info-zh.mjs           中文标注（手工词条 + 缓存 + 原文）
│   ├── registry.mjs          汇总层 + 操作分发
│   └── collectors/
│       ├── skills.mjs        技能
│       ├── plugins.mjs       插件
│       ├── providers.mjs     模型厂商（密钥打码）
│       ├── runtime.mjs       定时任务 + 常驻进程
│       └── sessions.mjs      会话记录
└── test/                     三个测试套件
```

---

## License

MIT
