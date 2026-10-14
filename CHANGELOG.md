# 更新记录

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## v0.1.1

修一个用不了的低级 bug，并补上防回归的手段。

### 修复

- **右侧栏面板不能滚动，藏在下面的内容看不见**（使用者实际反馈）。
  根容器只写了 `padding`，没有高度也没有 `overflow`，内容一长就被宿主容器裁掉。
  按官方 `dsh-client-ui-sidebar-browser` 的布局契约改成：
  根 `height:100%; min-height:0; flex:auto; display:flex; flex-direction:column`、
  顶部固定区 `flex:none`、列表区 `flex:1 1 auto; min-height:0; overflow-y:auto`。
  `min-height:0` 是关键：flex 子项默认 `min-height:auto`，不加滚动条根本不出现。
- 修掉布局改造中引入的一处括号不匹配（`node --check` 当场拦下）。

### 新增

- **布局回归测试**：直接读 `client.js` 源码断言那五个布局属性还在。
  界面 bug 没法在 CI 里点出来，但"契约被改掉了"可以。
- **GitHub Actions CI**：在 `windows-latest` 上跑（采集器依赖 Windows 的计划任务与进程接口，
  跑 Ubuntu 覆盖不到），Node 20 / 22 矩阵。
- **安装脚本自检**：把安装后的那一份在沙箱里拉起来，确认真能注册路由 ——
  避免"少拷了个文件"要等到重启应用才发现。
- `bin/status.mjs`：一条命令看仓库与 CI 状态。

### 改动

- 进程分类补上 Electron 的渲染/GPU/辅助进程，不再一律显示成"DSH 进程"。
- 插件列表分三档（正在加载 / 已声明依赖 / 依赖的依赖），默认收起最后一档，
  免得几百个内部包把列表淹掉。

## v0.1.0

首个版本。

- 六类统一管理：技能、插件、模型厂商、Windows 定时任务、常驻进程、会话记录
- 数据驱动：扫到什么显示什么，新增的东西自动出现，不写死清单
- 每项带中文说明；破坏性操作先弹确认框
- 永不硬删：所有删除进回收站，界面上可一键还原
- 自我保护：本程序与 `dsh-base` / `dsh-web-app` 禁止停用
- 零运行时依赖（自带 YAML 子集解析器，已与 js-yaml 对真实配置逐字段交叉验证）
