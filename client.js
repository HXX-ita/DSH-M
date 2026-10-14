/**
 * DSH-M 控制中心 —— 客户端（Web Bundle）
 *
 * 宿主以 window.__ModuleLoader__.load({ id, factory }) 加载本文件；
 * factory 内通过 inject 取得 ui 席位，注册一个右侧栏 Tab 及其面板。
 *
 * ⚠️ 布局约定（踩过坑，照官方 dsh-client-ui-sidebar-browser 学来的）：
 *   宿主把面板塞进一个 flex 容器里，**面板自己必须撑满并管理滚动**：
 *     root     { height:100%; min-height:0; display:flex; flex-direction:column; flex:auto }
 *     固定区   { flex:none }
 *     滚动区   { flex:1 1 auto; min-height:0; overflow-y:auto }
 *   最早我只写了个 `{ padding: '10px 12px' }`，没有高度也没有 overflow ——
 *   结果内容一长就被父容器裁掉，**下面的东西根本滚不到**（老板实际反馈过）。
 *   `min-height:0` 是关键：flex 子项默认 min-height:auto，不加就撑破容器、滚动条不出现。
 *
 * 设计原则（对着老板的真实需求做的）：
 *   1. 每一项都有一句**中文说明**，看不懂技术名词也能判断要不要关
 *   2. 破坏性操作**先问一句**再执行，而且是红色按钮，不是蓝色
 *   3. 🔒 标记的东西点不动（会把自己锁在门外的那些）
 *   4. 关错了不要紧：所有删除都进回收站，界面上能一键还原
 */
window.__ModuleLoader__.load({
  id: 'dsh-control-center',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    let react = require('react');

    const name = 'dsh-m-client';
    const inject = ['slots', 'sidebarRight', 'sidebarRightTabs'];

    const TAB_KIND = 'dsh-m';
    const TAB_ID = 'dsh-m/panel';
    const STATE_PATH = '/dsh-m/state';
    const ACTION_PATH = '/dsh-m/action';

    const h = react.createElement;

    const C = {
      bg: 'var(--dsh-surface-2, #1b1f27)',
      fg: 'var(--dsh-text-1, #e6e9ef)',
      dim: 'var(--dsh-text-3, #98a1b3)',
      line: 'var(--dsh-border-1, #2c3240)',
      good: '#3fb950',
      warn: '#d29922',
      bad: '#f85149',
      accent: '#58a6ff',
    };

    /** 操作按钮的中文名 + 是否危险 */
    const ACTIONS = {
      disable: { zh: '停用', danger: true, hint: '关掉它，但不会删除，随时可以再打开' },
      enable: { zh: '启用', danger: false, hint: '重新打开' },
      delete: { zh: '删除', danger: true, hint: '移进回收站，之后还能还原' },
      'delete-session': { zh: '删除记录', danger: true, hint: '移进回收站，之后还能还原' },
      'task-run': { zh: '立刻跑一次', danger: false, hint: '不等时间点，马上执行' },
      'task-stop': { zh: '停止', danger: true, hint: '正在运行的会被中断' },
      'task-enable': { zh: '启用任务', danger: false, hint: '恢复成到点自动运行' },
      'task-disable': { zh: '停用任务', danger: true, hint: '到点也不会再自动运行' },
      restore: { zh: '还原', danger: false, hint: '放回原来的位置' },
      open: { zh: '打开文件夹', danger: false, hint: '在文件管理器里打开它的位置' },
      // QQ 机器人专用（实现见 lib/qqbot.mjs）
      'qqbot-health': { zh: '体检', danger: false, hint: '看进程、父进程（孤儿检测）、网关连接和日志状态' },
      'qqbot-console': { zh: '改资料', danger: false, hint: '打开 QQ 开放平台的机器人资料页 —— 改昵称/头像必须在控制台做，腾讯没开放 API（每次改都要过审）' },
      'qqbot-restart': { zh: '重启机器人', danger: true, hint: '杀掉旧进程并用计划任务重新拉起（旧进程可能变成收不到消息的孤儿）' },
    };

    const baseBtn = {
      font: 'inherit', fontSize: 11, padding: '3px 9px', borderRadius: 6,
      border: '1px solid ' + C.line, background: 'transparent', color: C.fg,
      cursor: 'pointer', whiteSpace: 'nowrap',
    };
    const btn = (danger, disabled) => ({
      ...baseBtn,
      borderColor: danger ? C.bad : C.line,
      color: disabled ? C.dim : (danger ? C.bad : C.fg),
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
    });

    function Icon(props) {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none' },
        h('path', { d: 'M2 4h12M2 8h12M2 12h12', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }));
    }

    function Dot(props) {
      return h('span', {
        style: {
          display: 'inline-block', width: 7, height: 7, borderRadius: 4, flex: '0 0 auto',
          background: props.protected ? C.warn : (props.on ? C.good : C.dim), marginRight: 6,
        },
      });
    }

    // ── 布局：撑满 + 固定顶部 + 滚动列表 ──
    const ROOT = {
      height: '100%', minHeight: 0, flex: 'auto',
      display: 'flex', flexDirection: 'column',
      boxSizing: 'border-box', color: C.fg,
    };
    const TOP = {
      flex: 'none', padding: '10px 12px 8px 12px',
      borderBottom: '1px solid ' + C.line,
    };
    const SCROLL = {
      flex: '1 1 auto', minHeight: 0,
      overflowY: 'auto', overflowX: 'hidden',
      padding: '10px 12px 28px 12px',   // 底部留白，最后一项不贴着边
    };

    function Panel() {
      const [data, setData] = react.useState(null);
      const [err, setErr] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [group, setGroup] = react.useState('skills');
      const [query, setQuery] = react.useState('');
      const [toast, setToast] = react.useState(null);
      const [confirming, setConfirming] = react.useState(null);
      const [showTransitive, setShowTransitive] = react.useState(false);

      const load = react.useCallback(async () => {
        try {
          const r = await fetch(STATE_PATH, { cache: 'no-store' });
          const j = await r.json();
          if (j.ok) { setData(j); setErr(null); } else setErr(j.error || '服务端返回失败');
        } catch (e) { setErr(String((e && e.message) || e)); }
      }, []);

      react.useEffect(() => {
        let stop = false;
        const tick = async () => { if (!stop) await load(); if (!stop) setTimeout(tick, 15000); };
        tick();
        return () => { stop = true; };
      }, [load]);

      react.useEffect(() => {
        if (!toast) return;
        const t = setTimeout(() => setToast(null), 6000);
        return () => clearTimeout(t);
      }, [toast]);

      async function doAction(item, action) {
        setBusy(true);
        try {
          const r = await fetch(ACTION_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ group: item.group, action, id: item.id, profile: item.profile, path: item.path }),
          });
          const j = await r.json();
          if (j.ok) {
            if (j.state) setData(j.state);
            // 有些动作会带回一句人话（例如 QQ 机器人「体检」的结论），优先显示它
            const msg = j.result && j.result.message;
            setToast({ ok: true, text: msg || `已${ACTIONS[action] ? ACTIONS[action].zh : action}：${item.title}` });
          } else {
            setToast({ ok: false, text: '没成功：' + (j.error || '未知原因') });
            await load();
          }
        } catch (e) {
          setToast({ ok: false, text: '请求失败：' + String((e && e.message) || e) });
        } finally {
          setBusy(false);
          setConfirming(null);
        }
      }

      function click(item, action) {
        const spec = ACTIONS[action] || { zh: action, danger: false, hint: '' };
        if (spec.danger) setConfirming({ item, action, spec });
        else doAction(item, action);
      }

      const card = {
        background: C.bg, border: '1px solid ' + C.line, borderRadius: 8,
        padding: '8px 10px', marginBottom: 8,
      };
      const pill = (on) => ({
        fontSize: 11, padding: '2px 9px', borderRadius: 999, cursor: 'pointer',
        border: '1px solid ' + (on ? C.accent : C.line),
        background: on ? 'rgba(88,166,255,0.14)' : 'transparent',
        color: on ? C.accent : C.dim, whiteSpace: 'nowrap',
      });

      if (err && !data) return h('div', { style: { ...ROOT, padding: 12, color: C.bad } }, '读取失败：' + err);
      if (!data) return h('div', { style: { ...ROOT, padding: 12, color: C.dim } }, '加载中…');

      const groups = data.groups || [];
      const items = (data.items && data.items[group]) || [];
      const q = query.trim().toLowerCase();
      const filtered = items.filter((it) => {
        if (group === 'plugins' && !showTransitive && it.tier === 'transitive') return false;
        if (!q) return true;
        return (it.title + ' ' + (it.zh || '') + ' ' + (it.original || '')).toLowerCase().includes(q);
      });
      const curGroup = groups.find((x) => x.key === group);

      return h('div', { style: ROOT },
        // ══════ 固定顶部：切分类 / 搜索（不随列表滚动）══════
        h('div', { style: TOP },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { color: C.accent } }, h(Icon)),
            h('div', { style: { fontWeight: 600, fontSize: 13 } }, '控制中心'),
            h('button', {
              style: { ...baseBtn, marginLeft: 'auto' }, disabled: busy,
              onClick: () => { setBusy(true); load().finally(() => setBusy(false)); },
            }, busy ? '…' : '刷新')),
          h('div', { style: { fontSize: 10, color: C.dim, marginTop: 2 } },
            '更新于 ' + new Date(data.generatedAt).toLocaleTimeString() +
            (data.sessionTotal ? '　·　' + data.sessionTotal.text : '')),

          toast ? h('div', {
            style: {
              marginTop: 8, fontSize: 11, borderRadius: 8, padding: '6px 9px',
              border: '1px solid ' + (toast.ok ? C.good : C.bad),
              color: toast.ok ? C.good : C.bad,
            },
          }, toast.text) : null,

          data.errors && data.errors.length
            ? h('div', {
                style: {
                  marginTop: 8, fontSize: 11, borderRadius: 8, padding: '6px 9px',
                  border: '1px solid ' + C.warn, color: C.warn,
                },
              }, '有 ' + data.errors.length + ' 类信息没读到（不影响其他部分）：' + data.errors.map((e) => e.group).join('、'))
            : null,

          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 } },
            groups.map((g) => h('span', {
              key: g.key, style: pill(group === g.key), onClick: () => setGroup(g.key),
            }, `${g.zh} ${g.count}`)),
            h('span', {
              style: pill(group === 'trash'), onClick: () => setGroup('trash'),
            }, `回收站 ${(data.trash || []).length}`)),

          group !== 'trash' ? h('input', {
            value: query, onChange: (e) => setQuery(e.target.value),
            placeholder: '搜索名字或说明…',
            style: {
              width: '100%', boxSizing: 'border-box', marginTop: 8,
              padding: '5px 8px', fontSize: 11, borderRadius: 6,
              border: '1px solid ' + C.line, background: 'transparent', color: C.fg,
            },
          }) : null,

          h('div', { style: { fontSize: 11, color: C.dim, marginTop: 8 } },
            group === 'trash'
              ? '删掉的东西都在这儿，随时可以放回去。不会真的从磁盘上消失。'
              : (curGroup ? curGroup.desc : '')),

          group === 'plugins' ? h('label', {
            style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.dim, marginTop: 6, cursor: 'pointer' },
          },
            h('input', { type: 'checkbox', checked: showTransitive, onChange: (e) => setShowTransitive(e.target.checked) }),
            '也显示「依赖的依赖」（插件自动带进来的内部包，一般不用管）') : null),

        // ══════ 可滚动列表 ══════
        h('div', { style: SCROLL },
          group === 'trash'
            ? ((data.trash || []).length === 0
                ? h('div', { style: { ...card, color: C.dim, fontSize: 12 } }, '回收站是空的。')
                : (data.trash || []).map((t, i) => h('div', { key: i, style: card },
                    h('div', { style: { fontSize: 12, fontWeight: 600, wordBreak: 'break-all' } }, t.label || t.original),
                    h('div', { style: { fontSize: 10, color: C.dim, marginTop: 2 } },
                      '删于 ' + new Date(t.at).toLocaleString() + '　·　原位置：' + t.original),
                    h('div', { style: { marginTop: 6 } },
                      h('button', {
                        style: btn(false, !t.exists || busy),
                        disabled: !t.exists || busy,
                        onClick: () => doAction({ group: 'trash', id: t.stored, title: t.label }, 'restore'),
                      }, t.exists ? '还原' : '文件已不在')))))
            : (filtered.length === 0
                ? h('div', { style: { ...card, color: C.dim, fontSize: 12 } },
                    items.length === 0 ? '这一类暂时没有内容。' : '没有匹配「' + query + '」的项。')
                : filtered.map((it) => {
                    const acts = it.actions || [];
                    return h('div', { key: it.id, style: { ...card, opacity: it.enabled ? 1 : 0.62 } },
                      h('div', { style: { display: 'flex', alignItems: 'center', fontSize: 12 } },
                        h(Dot, { on: it.enabled, protected: it.protected }),
                        h('span', { style: { fontWeight: 600, wordBreak: 'break-all' } }, it.title),
                        it.protected ? h('span', { style: { color: C.warn, marginLeft: 4, fontSize: 11 } }, '🔒') : null,
                        h('span', { style: { marginLeft: 'auto', color: it.enabled ? C.good : C.dim, fontSize: 10, flex: '0 0 auto' } },
                          it.enabled ? '启用中' : '已停用')),
                      h('div', { style: { fontSize: 11, color: it.zh ? C.fg : C.warn, marginTop: 4, lineHeight: 1.5 } },
                        it.zh || ('（还没有中文说明）' + (it.original ? ' 原文：' + String(it.original).slice(0, 160) : ''))),
                      it.healthText ? h('div', { style: { fontSize: 10, color: C.warn, marginTop: 3 } }, '⚠ ' + it.healthText) : null,
                      it.meta ? h('div', { style: { fontSize: 10, color: C.dim, marginTop: 5, lineHeight: 1.6 } },
                        Object.entries(it.meta).map(([k, v]) => h('div', { key: k, style: { wordBreak: 'break-all' } }, k + '：' + v))) : null,
                      h('div', { style: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
                        acts.length === 0
                          ? h('span', { style: { fontSize: 10, color: C.dim } }, '这一项没有可执行的操作')
                          : acts.map((a) => {
                              const [verb] = a.split(':');
                              const spec = ACTIONS[verb] || { zh: verb, danger: false, hint: '' };
                              const disabled = busy || (it.protected && verb !== 'enable');
                              return h('button', {
                                key: a, style: btn(spec.danger, disabled), disabled,
                                title: it.protected && verb !== 'enable' ? '这是必需组件，禁止操作（会把界面弄坏）' : spec.hint,
                                onClick: () => click(it, a),
                              }, spec.zh);
                            })));
                  }))),

        // ══════ 确认弹窗（fixed，不受滚动区影响）══════
        confirming ? h('div', {
          style: {
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
          },
          onClick: () => setConfirming(null),
        },
          h('div', {
            style: {
              background: '#12161d', border: '1px solid ' + C.line, borderRadius: 10,
              padding: 16, maxWidth: 320, color: C.fg,
            },
            onClick: (e) => e.stopPropagation(),
          },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '确定要' + confirming.spec.zh + '吗？'),
            h('div', { style: { fontSize: 12, color: C.dim, marginBottom: 4, wordBreak: 'break-all' } }, confirming.item.title),
            h('div', { style: { fontSize: 11, color: C.dim, marginBottom: 12 } }, confirming.spec.hint || ''),
            confirming.action === 'disable' && group === 'plugins'
              ? h('div', { style: { fontSize: 11, color: C.warn, marginBottom: 12 } }, '插件停用后需要重启应用才会真正生效。')
              : null,
            h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
              h('button', { style: baseBtn, onClick: () => setConfirming(null) }, '取消'),
              h('button', {
                style: { ...baseBtn, borderColor: C.bad, color: C.bad, fontWeight: 600 },
                onClick: () => doAction(confirming.item, confirming.action),
              }, '确定' + confirming.spec.zh))))
          : null);
    }

    function apply(ctx) {
      const tabs = ctx.sidebarRightTabs;
      const slots = ctx.slots;
      const disposers = [];
      if (tabs && slots) {
        disposers.push(tabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => '控制中心',
          guide: [{ id: 'dsh-m', order: 85, title: () => '控制中心', description: () => '统一查看与开关技能、插件、模型厂商、定时任务、进程和会话', icon: Icon }],
        }));
        disposers.push(slots.inject('sidebar.right.pane.tab', () =>
          slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, Panel)));
      }
      ctx.effect(() => () => { for (const d of disposers) { try { d && d(); } catch { /* ignore */ } } });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});
