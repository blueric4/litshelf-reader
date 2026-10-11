/**
 * 首次启动引导：选文献文件（按文件所在文件夹入库）→ 选扫描策略 → 开始。
 *
 * 注意系统对话框的语义：桌面版弹的是**文件**对话框（`openFile` + 多选），
 * 选中的文件会按**它所在的文件夹**变成文献库；它选不了"一个还没有文献的文件夹"，
 * 所以这里除了「选择文献文件」还有一条「只添加文件夹」的手填路径入口。
 */
import { useState } from 'react';
import type { Settings } from '@shared/types';
import { useStore } from '../state/store';
import { api } from '../bridge';
import { promptDialog } from '../components/Overlays';
import { IconCheck, IconFileText, IconFolderPlus } from '../components/Icons';

export function Onboarding() {
  const caps = useStore((s) => s.capabilities);
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const finish = useStore((s) => s.finishOnboarding);
  const refresh = useStore((s) => s.refresh);
  const pushToast = useStore((s) => s.pushToast);
  const [depth, setDepth] = useState(8);
  const [fullText, setFullText] = useState<Settings['fullTextIndex']>(settings.fullTextIndex);
  const [autoMeta, setAutoMeta] = useState(false);
  const [added, setAdded] = useState<string[]>([]);

  /** 把文件夹加入文献库（同一个目录只加一次，多选同一文件夹的文件会去重） */
  const addDirs = async (dirs: string[]) => {
    for (const dir of [...new Set(dirs)]) {
      try {
        await api.addRoot(dir, { depth });
        setAdded((prev) => (prev.includes(dir) ? prev : [...prev, dir]));
        pushToast({ kind: 'success', message: '已开始扫描', detail: dir });
      } catch (err) {
        pushToast({ kind: 'error', message: '添加失败', detail: (err as Error).message });
      }
    }
    await refresh();
  };

  /** 选文献文件：桌面版弹原生文件对话框（可多选，按文件所在文件夹入库），浏览器形态下手填路径 */
  const pickFiles = async () => {
    if (caps.nativeDialogs) {
      await addDirs(await api.pickFolder().catch(() => []));
      return;
    }
    const typed = await promptDialog({
      title: '文献文件夹',
      message: '浏览器形态下请手动填写文献文件夹的完整路径，例如 D:\\文献',
      placeholder: 'D:\\文献',
      confirmLabel: '使用这个文件夹',
    });
    if (typed) await addDirs([typed]);
  };

  /**
   * 只添加文件夹：系统文件对话框只能选文件（选不了文件夹），
   * "文件夹里还没有文献 / 只想先挂一个空目录"就走这里手填路径。
   */
  const pickFolderOnly = async () => {
    const typed = await promptDialog({
      title: '只添加文件夹',
      message: (
        <>
          填写文件夹的完整路径，例如 <b>D:\文献</b>。文件夹里暂时还没有文献也可以，之后放进去的会自动入库。
        </>
      ),
      placeholder: 'D:\\文献',
      confirmLabel: '添加这个文件夹',
    });
    if (typed) await addDirs([typed]);
  };

  const createSamples = async () => {
    try {
      const res = await api.createSampleLibrary();
      setAdded((prev) => [...prev, res.dir]);
      pushToast({ kind: 'success', message: `已生成 ${res.files} 篇示例文献`, detail: res.dir });
      await refresh();
    } catch (err) {
      pushToast({ kind: 'error', message: '生成示例失败', detail: (err as Error).message });
    }
  };

  const start = async () => {
    await update({ fullTextIndex: fullText, autoMetadata: autoMeta, reconcileIntervalMs: settings.reconcileIntervalMs || 300000 });
    await finish();
  };

  return (
    <div className="onb">
      <div className="onb-card">
        <div className="onb-logo">文</div>
        <h1 className="onb-title">欢迎使用文献架</h1>
        <p className="onb-sub">
          指到一个装着文献的文件夹，文献架会自动识别里面的文件；之后文件夹里新增、改名、删除、覆盖保存，软件里都会跟着变。双击就能在软件内阅读 PDF，高亮批注和阅读位置会自动记住。
        </p>

        <div className="onb-steps">
          <div className="onb-step">
            <span className="onb-num">1</span>
            <span>
              选择你的文献<strong>文件</strong>（可以多选，比如 <b>D:\文献</b>、网盘同步目录、移动硬盘里的 PDF）；文献架会按文件<strong>所在的文件夹</strong>添加文献库
            </span>
          </div>
          <div className="onb-step">
            <span className="onb-num">2</span>
            <span>软件会在后台扫描并解析元数据，扫描期间界面可以正常使用</span>
          </div>
          <div className="onb-step">
            <span className="onb-num">3</span>
            <span>双击任意一篇即可在软件内阅读；框选文字就能高亮或写批注</span>
          </div>
        </div>

        <div className="set-group" style={{ marginBottom: 20 }}>
          <div className="set-row">
            <div className="set-row-label">
              <div className="set-row-title">子文件夹递归深度</div>
              <div className="set-row-hint">8 层足够覆盖绝大多数文献组织方式；更深会被忽略（可在设置里改）</div>
            </div>
            <div className="set-row-control">
              <select className="input" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
                <option value={1}>只看本层</option>
                <option value={3}>3 层</option>
                <option value={8}>8 层（推荐）</option>
                <option value={16}>16 层</option>
              </select>
            </div>
          </div>
          <div className="set-row">
            <div className="set-row-label">
              <div className="set-row-title">全文索引</div>
              <div className="set-row-hint">决定能否搜索 PDF 正文内容。选「只索引打开过的」最省资源</div>
            </div>
            <div className="set-row-control">
              <select className="input" value={fullText} onChange={(e) => setFullText(e.target.value as Settings['fullTextIndex'])}>
                <option value="opened-only">只索引打开过的（推荐）</option>
                <option value="all">首次就索引全部</option>
                <option value="off">不要全文索引</option>
              </select>
            </div>
          </div>
          <div className="set-row">
            <div className="set-row-label">
              <div className="set-row-title">自动联网补全元数据</div>
              <div className="set-row-hint">用 Crossref / arXiv 补作者、年份、期刊。默认手动触发更可控</div>
            </div>
            <div className="set-row-control">
              <button className={`switch${autoMeta ? ' on' : ''}`} onClick={() => setAutoMeta(!autoMeta)} role="switch" aria-checked={autoMeta} />
            </div>
          </div>
        </div>

        {added.length ? (
          <div className="onb-note" style={{ color: 'var(--c-green)', marginBottom: 12 }}>
            <IconCheck size={13} /> 已添加：{added.map((a) => a.split(/[\\/]/).pop()).join('、')}
          </div>
        ) : null}

        <div className="onb-actions">
          <button className="btn primary" onClick={pickFiles} title="选择文献文件（可多选、可按类型筛选）；会按文件所在的文件夹添加">
            <IconFileText size={14} /> 选择文献文件（可多选）
          </button>
          <button className="btn" onClick={pickFolderOnly} title="只添加文件夹（手动填写路径）：文件夹里还没有文献时用这个">
            <IconFolderPlus size={14} /> 只添加文件夹
          </button>
          <button className="btn" onClick={createSamples}>
            先生成示例文献看看
          </button>
          <button className="btn ghost" onClick={start}>
            {added.length ? '开始使用' : '跳过，直接进去'}
          </button>
        </div>
        <div className="onb-note" style={{ marginTop: 10 }}>
          系统对话框里选的是<b>文献文件</b>（可多选），文献架按文件所在的文件夹入库；文件夹里还没有文献、或只想先挂一个空目录，用「只添加文件夹」手动填写路径。
        </div>
        <div className="onb-note">
          文献架<strong>只读取</strong>你的文件夹，绝不改名、移动或删除文件；索引、笔记、批注都存在本地数据目录。随时可以在设置里增删文献库。
        </div>
      </div>
    </div>
  );
}
