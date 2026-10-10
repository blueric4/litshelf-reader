/**
 * 设置页：文献库、扫描、阅读、元数据、外观、数据维护、关于。
 */
import { useEffect, useMemo, useState } from 'react';
import { SIDEBAR_EXTRA_FILTERS, normalizeSidebarExtraFilters, type Settings, type SidebarExtraFilter } from '@shared/types';
import { HIGHLIGHT_COLORS } from '@shared/types';
import { useStore } from '../state/store';
import { api, isElectron, platform } from '../bridge';
import { confirmDialog, promptDialog } from '../components/Overlays';
import { IconExternal, IconFolderPlus, IconRefresh, IconTrash, IconWarning } from '../components/Icons';
import { formatRelative, modKey } from '../utils/format';

type Section = 'roots' | 'scan' | 'reader' | 'meta' | 'appearance' | 'data' | 'about';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'roots', label: '文献库' },
  { id: 'scan', label: '扫描与索引' },
  { id: 'reader', label: '阅读' },
  { id: 'meta', label: '元数据' },
  { id: 'appearance', label: '外观' },
  { id: 'data', label: '数据与维护' },
  { id: 'about', label: '关于' },
];

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on} />;
}

/** 侧栏默认不显示的筛选项（顺序来自 @shared/types，和侧栏里的一致） */
const EXTRA_SIDEBAR_ORDER: readonly SidebarExtraFilter[] = SIDEBAR_EXTRA_FILTERS;
/** 用 Record 收口：以后往 SidebarExtraFilter 里加 key，这里漏了文案会直接编译不过 */
const EXTRA_SIDEBAR_LABELS: Record<SidebarExtraFilter, string> = {
  unread: '未读',
  toread: '待读清单',
  annotated: '有批注',
  noted: '有笔记',
  missing: '文件缺失',
};
const EXTRA_SIDEBAR_HINTS: Record<SidebarExtraFilter, string> = {
  unread: '还没读完的文献',
  toread: '星标了但还没开始读的',
  annotated: '至少有一条批注或书签',
  noted: '写过笔记的文献',
  missing: '有文件缺失时才出现',
};

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-label">
        <div className="set-row-title">{title}</div>
        {hint ? <div className="set-row-hint">{hint}</div> : null}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

export function SettingsView() {
  const section = useStore((s) => s.settingsSection);
  const setSection = useStore((s) => s.setSettingsSection);
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const roots = useStore((s) => s.roots);
  const items = useStore((s) => s.items);
  const capabilities = useStore((s) => s.capabilities);
  const dataDir = useStore((s) => s.dataDir);
  const version = useStore((s) => s.version);
  const pushToast = useStore((s) => s.pushToast);
  const refresh = useStore((s) => s.refresh);
  const [stats, setStats] = useState<{ items: number; missing: number; ready: number; failed: number; textIndexed: number; annotations: number } | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const computed = {
      items: items.length,
      missing: items.filter((i) => i.missing).length,
      ready: items.filter((i) => i.parseState === 'ready').length,
      failed: items.filter((i) => i.parseState === 'failed').length,
      textIndexed: items.filter((i) => i.textIndexed).length,
      annotations: items.reduce((n, i) => n + i.annotationCount, 0),
    };
    setStats(computed);
  }, [items]);

  const totalSize = useMemo(() => items.reduce((n, i) => n + i.size, 0), [items]);

  const addRoot = async () => {
    let picked: string[] = [];
    if (capabilities.nativeDialogs) picked = await api.pickFolder().catch(() => []);
    else picked = [];
    if (!picked.length && !capabilities.nativeDialogs) {
      const typed = await promptDialog({ title: '添加文献文件夹', message: '请填写文件夹完整路径', placeholder: 'D:\\文献', confirmLabel: '添加' });
      if (typed) picked = [typed];
    }
    for (const dir of picked) {
      await api.addRoot(dir, { depth: 8 }).catch((err) => pushToast({ kind: 'error', message: '添加失败', detail: err.message }));
    }
    await refresh();
  };

  return (
    <div className="set">
      <nav className="set-nav">
        {SECTIONS.map((s) => (
          <button key={s.id} className={`set-nav-item${section === s.id ? ' active' : ''}`} onClick={() => setSection(s.id)}>
            {s.label}
          </button>
        ))}
      </nav>
      <div className="set-body">
        <div className="set-inner">
          {section === 'roots' ? (
            <>
              <h1 className="set-h">文献库</h1>
              <p className="set-desc">
                文献架只会<strong>读取</strong>这些文件夹，绝不改名、移动或删除你的文件。文件夹里的任何变化（新增、改名、删除、覆盖保存）都会自动同步到软件内。
              </p>
              <div className="set-group">
                {roots.length === 0 ? (
                  <div className="set-row">
                    <div className="set-row-label">
                      <div className="set-row-title">还没有添加文献文件夹</div>
                      <div className="set-row-hint">选一个装着 PDF 的文件夹即可开始</div>
                    </div>
                  </div>
                ) : (
                  roots.map((root) => (
                    <div className="root-card" key={root.id}>
                      <div className="root-info">
                        <div className="root-name">
                          {root.available ? null : <IconWarning size={13} />}
                          {root.name}
                          {!root.enabled ? <span className="chip plain">已暂停</span> : null}
                        </div>
                        <div className="root-path">{root.path}</div>
                        <div className="root-stat">
                          {items.filter((i) => i.rootId === root.id).length} 篇 · 递归深度 {root.depth} ·{' '}
                          {root.lastScanAt ? `上次扫描 ${formatRelative(root.lastScanAt)}` : '尚未扫描'}
                        </div>
                      </div>
                      <Switch on={root.enabled} onChange={(v) => void api.setRootEnabled(root.id, v).then(refresh)} />
                      <button className="icon-btn" title="重新扫描" onClick={() => void api.rescan(root.id)}>
                        <IconRefresh size={15} />
                      </button>
                      <button
                        className="icon-btn"
                        title="移除"
                        onClick={async () => {
                          const ok = await confirmDialog({
                            title: `移除「${root.name}」？`,
                            message: (
                              <>
                                只是不再监听它，<strong>磁盘文件不动</strong>。已入库条目的标签、笔记、批注都会保留（变为「文件缺失」状态）。
                              </>
                            ),
                            confirmLabel: '移除',
                          });
                          if (ok) {
                            await api.removeRoot(root.id, { forgetItems: false });
                            await refresh();
                          }
                        }}
                      >
                        <IconTrash size={15} />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <button className="btn" onClick={addRoot}>
                <IconFolderPlus size={14} /> 添加文献文件夹
              </button>
              <div style={{ marginTop: 10 }}>
                <button
                  className="btn"
                  disabled={busy === 'sample'}
                  onClick={async () => {
                    setBusy('sample');
                    try {
                      const res = await api.createSampleLibrary();
                      pushToast({ kind: 'success', message: `已生成 ${res.files} 篇示例文献`, detail: res.dir });
                      await refresh();
                    } catch (err) {
                      pushToast({ kind: 'error', message: '生成示例失败', detail: (err as Error).message });
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  生成示例文献（用来试功能，可随时删掉）
                </button>
              </div>
            </>
          ) : null}

          {section === 'scan' ? (
            <>
              <h1 className="set-h">扫描与索引</h1>
              <p className="set-desc">扫描分三步：先发现文件（立刻显示条目）→ 建立内容指纹（识别改名与移动）→ 后台解析元数据。界面全程可交互。</p>
              <div className="set-group">
                <Row title="全文索引" hint="打开过的文献会自动建立全文索引，之后能用 Ctrl+K 搜到正文内容">
                  <select
                    className="input"
                    value={settings.fullTextIndex}
                    onChange={(e) => void update({ fullTextIndex: e.target.value as Settings['fullTextIndex'] })}
                  >
                    <option value="opened-only">只索引打开过的（推荐）</option>
                    <option value="all">首次扫描就索引全部（耗时，但搜索最全）</option>
                    <option value="off">完全关闭全文索引</option>
                  </select>
                </Row>
                <Row title="生成封面缩略图" hint="用首页渲染的小图做网格视图封面">
                  <Switch on={settings.thumbnails} onChange={(v) => void update({ thumbnails: v })} />
                </Row>
                <Row title="解析并发数" hint="越高越快，但会占用更多 CPU；文献多时建议 4">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={12}
                    value={settings.concurrency}
                    onChange={(e) => void update({ concurrency: Math.max(1, Math.min(12, Number(e.target.value) || 4)) })}
                  />
                </Row>
                <Row title="收录非文献类文件" hint="默认只收录 PDF、Markdown、文本、HTML、图片、Word、EPUB 等">
                  <Switch on={settings.includeOtherFiles} onChange={(v) => void update({ includeOtherFiles: v })} />
                </Row>
                <Row title="一致性巡检间隔" hint="万一网盘/移动硬盘不推送文件变化事件，靠它兜底">
                  <select
                    className="input"
                    value={String(settings.reconcileIntervalMs)}
                    onChange={(e) => void update({ reconcileIntervalMs: Number(e.target.value) })}
                  >
                    <option value="0">关闭</option>
                    <option value="60000">每分钟</option>
                    <option value="300000">每 5 分钟</option>
                    <option value="900000">每 15 分钟</option>
                  </select>
                </Row>
              </div>
            </>
          ) : null}

          {section === 'reader' ? (
            <>
              <h1 className="set-h">阅读</h1>
              <div className="set-group">
                <Row title="默认缩放">
                  <select
                    className="input"
                    value={String(settings.defaultZoom)}
                    onChange={(e) =>
                      void update({ defaultZoom: e.target.value === 'fit-width' || e.target.value === 'fit-page' ? e.target.value : Number(e.target.value) })
                    }
                  >
                    <option value="fit-width">适应宽度</option>
                    <option value="fit-page">适应页面</option>
                    <option value="0.75">75%</option>
                    <option value="1">100%</option>
                    <option value="1.25">125%</option>
                    <option value="1.5">150%</option>
                  </select>
                </Row>
                <Row title="页面布局">
                  <select className="input" value={settings.readerLayout} onChange={(e) => void update({ readerLayout: e.target.value as Settings['readerLayout'] })}>
                    <option value="continuous">连续滚动</option>
                    <option value="single">单页</option>
                    <option value="double">双页</option>
                  </select>
                </Row>
                <Row title="阅读背景">
                  <select className="input" value={settings.readerTheme} onChange={(e) => void update({ readerTheme: e.target.value as Settings['readerTheme'] })}>
                    <option value="light">浅色</option>
                    <option value="sepia">护眼（米色）</option>
                    <option value="dark">深色</option>
                  </select>
                </Row>
                <Row title="翻页动画">
                  <Switch on={settings.readerAnimation} onChange={(v) => void update({ readerAnimation: v })} />
                </Row>
                <Row title="默认高亮颜色">
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(Object.keys(HIGHLIGHT_COLORS) as (keyof typeof HIGHLIGHT_COLORS)[]).map((c) => (
                      <button
                        key={c}
                        title={HIGHLIGHT_COLORS[c].label}
                        onClick={() => void update({ annotationColor: c })}
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 6,
                          background: HIGHLIGHT_COLORS[c].light,
                          border: settings.annotationColor === c ? '2px solid var(--accent)' : '1px solid var(--line)',
                        }}
                      />
                    ))}
                  </div>
                </Row>
              </div>
            </>
          ) : null}

          {section === 'meta' ? (
            <>
              <h1 className="set-h">元数据</h1>
              <p className="set-desc">联网补全使用 Crossref 与 arXiv 的公开接口，结果会缓存在本地 30 天。断网时所有核心功能照常可用。</p>
              <div className="set-group">
                <Row title="允许联网查询" hint="关闭后完全离线，任何按钮都不会发网络请求">
                  <Switch on={settings.onlineMetadata} onChange={(v) => void update({ onlineMetadata: v })} />
                </Row>
                <Row title="自动补全" hint="开启后每篇解析完自动查一次；默认关闭，需要时手动点「补全元数据」">
                  <Switch on={settings.autoMetadata} onChange={(v) => void update({ autoMetadata: v })} />
                </Row>
                <Row title="批量补全当前库" hint="只补空缺字段，不会覆盖你手动改过的内容">
                  <button
                    className="btn"
                    disabled={busy === 'meta'}
                    onClick={async () => {
                      setBusy('meta');
                      try {
                        const res = await api.completeMetadata(items.slice(0, 60).map((i) => i.id));
                        pushToast({ kind: 'success', message: `补全完成：更新 ${res.updated} 篇`, detail: `跳过 ${res.skipped}，失败 ${res.failed}（单次最多 60 篇）` });
                        await refresh();
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    开始补全（最多 60 篇）
                  </button>
                </Row>
              </div>
            </>
          ) : null}

          {section === 'appearance' ? (
            <>
              <h1 className="set-h">外观</h1>
              <div className="set-group">
                <Row title="主题">
                  <select className="input" value={settings.theme} onChange={(e) => void update({ theme: e.target.value as Settings['theme'] })}>
                    <option value="system">跟随系统</option>
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                  </select>
                </Row>
                <Row title="列表密度">
                  <select className="input" value={settings.density} onChange={(e) => void update({ density: e.target.value as Settings['density'] })}>
                    <option value="comfortable">舒适</option>
                    <option value="compact">紧凑</option>
                  </select>
                </Row>
                <Row title="默认视图">
                  <select className="input" value={settings.listView} onChange={(e) => void update({ listView: e.target.value as Settings['listView'] })}>
                    <option value="list">紧凑列表</option>
                    <option value="comfortable">舒适列表（含摘要）</option>
                    <option value="grid">网格（封面）</option>
                  </select>
                </Row>
                <Row title="默认分组">
                  <select className="input" value={settings.groupBy} onChange={(e) => void update({ groupBy: e.target.value as Settings['groupBy'] })}>
                    <option value="none">不分组</option>
                    <option value="read">按阅读状态</option>
                    <option value="folder">按文件夹</option>
                    <option value="year">按年份</option>
                    <option value="tag">按标签</option>
                    <option value="added">按添加时间</option>
                  </select>
                </Row>
                {isElectron ? (
                  <Row title="关闭窗口时最小化到托盘" hint="关掉窗口后仍继续监听文件夹变化">
                    <Switch on={settings.minimizeToTray} onChange={(v) => void update({ minimizeToTray: v })} />
                  </Row>
                ) : null}
              </div>
              <div className="set-group">
                <Row title="侧栏显示的其它筛选" hint="侧栏默认只有 全部文献 / 最近添加 / 在读 / 星标；勾选下面的项目会把它们追加到侧栏">
                  <span className="chip plain">
                    {normalizeSidebarExtraFilters(settings.sidebarExtraFilters).length}/{EXTRA_SIDEBAR_ORDER.length} 项已显示
                  </span>
                </Row>
                {EXTRA_SIDEBAR_ORDER.map((key) => (
                  <Row key={key} title={EXTRA_SIDEBAR_LABELS[key]} hint={EXTRA_SIDEBAR_HINTS[key]}>
                    <Switch
                      on={normalizeSidebarExtraFilters(settings.sidebarExtraFilters).includes(key)}
                      onChange={(v) => {
                        const current = normalizeSidebarExtraFilters(settings.sidebarExtraFilters);
                        void update({
                          sidebarExtraFilters: EXTRA_SIDEBAR_ORDER.filter((k) => (k === key ? v : current.includes(k))),
                        });
                      }}
                    />
                  </Row>
                ))}
              </div>
            </>
          ) : null}

          {section === 'data' ? (
            <>
              <h1 className="set-h">数据与维护</h1>
              {stats ? (
                <div className="stat-grid">
                  <div className="stat-card">
                    <div className="stat-num">{stats.items}</div>
                    <div className="stat-label">文献条目</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-num">{stats.ready}</div>
                    <div className="stat-label">已完成解析</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-num">{stats.textIndexed}</div>
                    <div className="stat-label">已建全文索引</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-num">{stats.annotations}</div>
                    <div className="stat-label">批注</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-num">{stats.missing}</div>
                    <div className="stat-label">文件缺失</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-num">{(totalSize / 1024 / 1024 / 1024).toFixed(2)}</div>
                    <div className="stat-label">GB 文献体积</div>
                  </div>
                </div>
              ) : null}
              <div className="set-group">
                <Row title="数据目录" hint={dataDir || '（浏览器形态下由后端进程决定）'}>
                  <button className="btn" onClick={() => void api.openDataDir()}>
                    <IconExternal size={13} /> 打开
                  </button>
                </Row>
                <Row title="导出文献库" hint="BibTeX / CSV 表格 / 笔记与批注 Markdown">
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn sm" onClick={() => void api.exportLibrary({ format: 'bibtex' }).then(() => pushToast({ kind: 'success', message: '已导出 BibTeX' }))}>
                      BibTeX
                    </button>
                    <button className="btn sm" onClick={() => void api.exportLibrary({ format: 'csv' }).then(() => pushToast({ kind: 'success', message: '已导出 CSV' }))}>
                      CSV
                    </button>
                    <button
                      className="btn sm"
                      onClick={() => void api.exportLibrary({ format: 'markdown-notes' }).then(() => pushToast({ kind: 'success', message: '已导出笔记' }))}
                    >
                      笔记
                    </button>
                  </div>
                </Row>
                <Row title="重建索引" hint="重新扫描全部文献库并重解析元数据；标签、笔记、批注、阅读进度不受影响">
                  <button
                    className="btn"
                    disabled={busy === 'rebuild'}
                    onClick={async () => {
                      const ok = await confirmDialog({
                        title: '重建索引？',
                        message: '会重新扫描并解析所有文献，耗时取决于文献数量。你的标签、笔记、批注和阅读进度都会保留。',
                        confirmLabel: '开始重建',
                      });
                      if (!ok) return;
                      setBusy('rebuild');
                      try {
                        await api.rebuildIndex();
                        pushToast({ kind: 'success', message: '重建完成' });
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === 'rebuild' ? '重建中…' : '重建索引'}
                  </button>
                </Row>
                <Row title="清理缓存" hint="缩略图与全文索引缓存；清掉后会自动重新生成">
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn sm" onClick={() => void api.clearCache('thumbs').then(() => pushToast({ kind: 'success', message: '缩略图缓存已清理' }))}>
                      缩略图
                    </button>
                    <button className="btn sm" onClick={() => void api.clearCache('text').then(() => pushToast({ kind: 'success', message: '全文索引已清理' }))}>
                      全文索引
                    </button>
                    <button className="btn sm" onClick={() => void api.clearCache('all').then(() => pushToast({ kind: 'success', message: '缓存已全部清理' }))}>
                      全部
                    </button>
                  </div>
                </Row>
                <Row title="导出诊断报告" hint="包含设置、文献库状态与最近日志，排查问题时很有用">
                  <button
                    className="btn"
                    onClick={async () => {
                      const res = await api.exportDiagnostics();
                      pushToast({ kind: 'success', message: '诊断报告已导出', detail: res.savedTo });
                    }}
                  >
                    导出
                  </button>
                </Row>
              </div>
            </>
          ) : null}

          {section === 'about' ? (
            <>
              <h1 className="set-h">关于文献架</h1>
              <p className="set-desc">
                版本 {version || '1.0.0'} · {isElectron ? '桌面形态' : '浏览器形态'} · 平台 {platform}
                <br />
                文献架只读你的文献文件夹，所有数据都存在本地数据目录里，不上传任何内容。
              </p>
              <div className="set-group">
                <Row title="快捷键" hint="阅读器里还有一套独立快捷键">
                  <span className="kbd">{modKey()}+K</span>
                </Row>
                <div style={{ padding: '10px 0' }}>
                  <div className="shortcuts">
                    {[
                      [`${modKey()}+K`, '聚焦搜索框'],
                      ['J / K', '上下移动选择'],
                      ['Enter', '打开选中文献'],
                      ['Space', '切换已读/未读'],
                      ['S', '切换星标'],
                      ['E', '编辑笔记'],
                      ['Esc', '返回 / 关闭'],
                      ['?', '这个快捷键面板'],
                      [`${modKey()}+R`, '重新扫描全部文献库'],
                    ].map(([key, label]) => (
                      <div className="shortcut-row" key={key}>
                        <span>{label}</span>
                        <span className="kbd">{key}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="set-group">
                <Row title="把软件跑在哪" hint="桌面形态是独立窗口；浏览器形态跑在 127.0.0.1:7788，功能一致">
                  <span className="chip plain">{isElectron ? 'Electron' : 'Web'}</span>
                </Row>
                <Row title="重新打开引导页">
                  <button className="btn" onClick={() => useStore.setState({ showOnboarding: true })}>
                    打开引导
                  </button>
                </Row>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
