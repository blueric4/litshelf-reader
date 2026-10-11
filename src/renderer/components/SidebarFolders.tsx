/**
 * 侧边栏的文献库文件夹树：每个根目录一棵可展开的树，节点右侧是在该目录下的文献数。
 *
 * 添加入口有两条（系统文件对话框选不了文件夹，两条都得留着）：
 *   1. 「选择文献文件」→ 原生**文件**对话框（多选），按文件所在的文件夹入库；
 *   2. 「手动填写路径」→ 直接填文件夹路径，文件夹里还没有文献时用这条。
 */
import { useMemo } from 'react';
import type { Item } from '@shared/types';
import { useStore } from '../state/store';
import { isFolderMatch } from '../state/selectors';
import { api } from '../bridge';
import { confirmDialog, promptDialog, usePopup } from './Overlays';
import { IconChevronRight, IconFileText, IconFolder, IconFolderPlus, IconRefresh, IconTrash, IconWarning, IconX } from './Icons';

/** 两个添加入口的悬停提示：空库与有库两处都用同一份文案 */
const FILE_PICK_HINT = '选择文献文件（可多选、可按类型筛选）；会按文件所在的文件夹添加';
const PATH_HINT = '手动填写路径：文件夹里还没有文献时用这个';

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  count: number;
}

function buildTree(dirs: string[], items: Item[]) {
  const root: TreeNode = { name: '', path: '', children: [], count: 0 };
  const nodes = new Map<string, TreeNode>([['', root]]);
  for (const dir of dirs) {
    const parts = dir.split('/').filter(Boolean);
    let parentPath = '';
    for (const part of parts) {
      const path = parentPath ? `${parentPath}/${part}` : part;
      if (!nodes.has(path)) {
        const node: TreeNode = { name: part, path, children: [], count: 0 };
        nodes.set(path, node);
        (nodes.get(parentPath) ?? root).children.push(node);
      }
      parentPath = path;
    }
  }
  for (const node of nodes.values()) {
    node.count = items.filter((i) => isFolderMatch(i, node.path)).length;
  }
  const sortRec = (node: TreeNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
    node.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

export function SidebarFolders() {
  const roots = useStore((s) => s.roots);
  const folderTree = useStore((s) => s.folderTree);
  const items = useStore((s) => s.items);
  const collapsedRoots = useStore((s) => s.collapsedRoots);
  const toggleRoot = useStore((s) => s.toggleRoot);
  const expandedFolders = useStore((s) => s.expandedFolders);
  const toggleFolder = useStore((s) => s.toggleFolder);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const setView = useStore((s) => s.setView);
  const pushToast = useStore((s) => s.pushToast);
  const refresh = useStore((s) => s.refresh);

  const trees = useMemo(
    () =>
      roots.map((root) => ({
        root,
        nodes: buildTree(folderTree.find((t) => t.rootId === root.id)?.dirs ?? [], items.filter((i) => i.rootId === root.id)),
        count: items.filter((i) => i.rootId === root.id).length,
      })),
    [roots, folderTree, items],
  );

  /** 把文件夹加入文献库（同一个目录只加一次） */
  const addDirs = async (dirs: string[]) => {
    for (const dir of [...new Set(dirs)]) {
      try {
        await api.addRoot(dir, { depth: 8 });
        pushToast({ kind: 'success', message: '已添加文献库', detail: dir });
        await refresh();
      } catch (err) {
        pushToast({ kind: 'error', message: '添加失败', detail: (err as Error).message });
      }
    }
  };

  /**
   * 手动填写路径：系统文件对话框只能选文件，"只想加一个文件夹"
   * （尤其是文件夹里还没有文献）必须留这条入口，不能藏在 nativeDialogs 的 else 分支里。
   */
  const addByPath = async () => {
    const typed = await promptDialog({
      title: '手动填写路径',
      message: (
        <>
          填写文献文件夹的完整路径，例如 <b>D:\文献</b>。文件夹里暂时还没有文献也可以，之后放进去的会自动入库。
        </>
      ),
      placeholder: 'D:\\文献',
      confirmLabel: '添加',
    });
    if (typed) await addDirs([typed]);
  };

  /** 选文献文件：桌面版走原生文件对话框（多选，按文件所在文件夹入库），浏览器形态退化成手填路径 */
  const pickFiles = async () => {
    const caps = useStore.getState().capabilities;
    if (!caps.nativeDialogs) {
      await addByPath();
      return;
    }
    await addDirs(await api.pickFolder().catch(() => []));
  };

  if (!roots.length) {
    return (
      <div className="sb-section">
        <div className="sb-section-title">文献库</div>
        <button className="sb-add" onClick={pickFiles} title={FILE_PICK_HINT}>
          <IconFileText size={13} /> 选择文献文件（可多选）
        </button>
        <button className="sb-add" style={{ color: 'var(--text-2)' }} onClick={addByPath} title={PATH_HINT}>
          <IconFolderPlus size={13} /> 手动填写路径
        </button>
      </div>
    );
  }

  return (
    <div className="sb-section">
      <div className="sb-section-title">
        <span>文献库</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <button className="icon-btn" style={{ width: 20, height: 20 }} title={FILE_PICK_HINT} onClick={pickFiles}>
            <IconFileText size={12} />
          </button>
          <button className="icon-btn" style={{ width: 20, height: 20 }} title={PATH_HINT} onClick={addByPath}>
            <IconFolderPlus size={12} />
          </button>
        </span>
      </div>
      {trees.map(({ root, nodes, count }) => (
        <RootRow key={root.id} rootId={root.id} name={root.name} path={root.path} count={count} available={root.available} enabled={root.enabled}>
          {!collapsedRoots.includes(root.id) &&
            nodes.map((node) => (
              <FolderNode
                key={node.path}
                node={node}
                rootId={root.id}
                depth={1}
                expanded={expandedFolders}
                onToggle={toggleFolder}
                active={filter.kind === 'folder' && filter.rootId === root.id && filter.value === node.path}
                onSelect={() => {
                  setFilter({ kind: 'folder', rootId: root.id, value: node.path, label: node.name });
                  setView('library');
                }}
              />
            ))}
        </RootRow>
      ))}
    </div>
  );
}

function RootRow({
  rootId,
  name,
  path,
  count,
  available,
  enabled,
  children,
}: {
  rootId: string;
  name: string;
  path: string;
  count: number;
  available: boolean;
  enabled: boolean;
  children?: React.ReactNode;
}) {
  const collapsed = useStore((s) => s.collapsedRoots.includes(rootId));
  const toggleRoot = useStore((s) => s.toggleRoot);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const setView = useStore((s) => s.setView);
  const pushToast = useStore((s) => s.pushToast);
  const refresh = useStore((s) => s.refresh);
  const popup = usePopup();

  const active = filter.kind === 'folder' && filter.rootId === rootId && !filter.value;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button
          className="icon-btn"
          style={{ width: 18, height: 18, flexShrink: 0 }}
          onClick={() => toggleRoot(rootId)}
          title={collapsed ? '展开' : '折叠'}
        >
          <IconChevronRight size={11} className={collapsed ? '' : 'sb-caret open'} />
        </button>
        <button
          className={`sb-item${active ? ' active' : ''}`}
          style={{ paddingLeft: 2, opacity: enabled ? 1 : 0.5 }}
          title={path}
          onClick={() => {
            setFilter({ kind: 'folder', rootId, value: '', label: name });
            setView('library');
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            popup.openFromEvent(e, [
              { header: true, label: name },
              {
                label: '立即重新扫描',
                icon: <IconRefresh size={13} />,
                onClick: async () => {
                  await api.rescan(rootId);
                  pushToast({ kind: 'info', message: `正在重新扫描「${name}」` });
                },
              },
              {
                label: enabled ? '暂停监听这个文件夹' : '恢复监听',
                onClick: async () => {
                  await api.setRootEnabled(rootId, !enabled);
                  pushToast({ kind: 'info', message: enabled ? `已暂停「${name}」的自动同步` : `已恢复「${name}」的自动同步` });
                  await refresh();
                },
              },
              { separator: true },
              {
                label: '移除文献库（保留条目）',
                icon: <IconX size={13} />,
                onClick: async () => {
                  const ok = await confirmDialog({
                    title: `移除文献库「${name}」？`,
                    message: (
                      <>
                        只是不再监听这个文件夹，<strong>磁盘上的文件不会被删除</strong>。已入库的条目会变成「文件缺失」状态，标签、笔记、批注都还在。
                      </>
                    ),
                    confirmLabel: '移除',
                  });
                  if (ok) {
                    await api.removeRoot(rootId, { forgetItems: false });
                    await refresh();
                    pushToast({ kind: 'success', message: `已移除「${name}」` });
                  }
                },
              },
              {
                label: '移除并忘记这些条目',
                danger: true,
                icon: <IconTrash size={13} />,
                onClick: async () => {
                  const ok = await confirmDialog({
                    title: `从库中彻底移除「${name}」？`,
                    message: (
                      <>
                        将移除该文件夹下的 <strong>{count}</strong> 条文献记录（含笔记与批注），<strong>磁盘文件不会被删除</strong>。此操作可以撤销 10 分钟。
                      </>
                    ),
                    confirmLabel: '移除条目',
                    danger: true,
                  });
                  if (ok) {
                    await api.removeRoot(rootId, { forgetItems: true });
                    await refresh();
                    pushToast({
                      kind: 'success',
                      message: `已移除「${name}」及其 ${count} 条记录`,
                      action: { label: '撤销', name: 'deleteItems' },
                    });
                  }
                },
              },
            ]);
          }}
        >
          <span className={`sb-icon ${available ? 'blue' : 'red'}`}>
            {available ? <IconFolder size={12} /> : <IconWarning size={12} />}
          </span>
          <span className="sb-label">{name}</span>
          <span className="sb-count">{count || ''}</span>
        </button>
      </div>
      {children}
      {popup.element}
    </>
  );
}

function FolderNode({
  node,
  rootId,
  depth,
  expanded,
  onToggle,
  active,
  onSelect,
}: {
  node: TreeNode;
  rootId: string;
  depth: number;
  expanded: string[];
  onToggle: (path: string) => void;
  active: boolean;
  onSelect: () => void;
}) {
  const open = expanded.includes(`${rootId}:${node.path}`);
  const hasChildren = node.children.length > 0;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', paddingLeft: depth * 10 }}>
        <button
          className="icon-btn"
          style={{ width: 16, height: 16, flexShrink: 0, visibility: hasChildren ? 'visible' : 'hidden' }}
          onClick={() => onToggle(`${rootId}:${node.path}`)}
          title={open ? '折叠' : '展开'}
        >
          <IconChevronRight size={10} className={open ? 'sb-caret open' : ''} />
        </button>
        <button className={`sb-item${active ? ' active' : ''}`} style={{ height: 28, paddingLeft: 2 }} onClick={onSelect} title={node.path}>
          <span className="sb-label" style={{ fontSize: 13 }}>
            {node.name}
          </span>
          <span className="sb-count">{node.count || ''}</span>
        </button>
      </div>
      {open &&
        node.children.map((child) => (
          <FolderNode
            key={child.path}
            node={child}
            rootId={rootId}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            active={false}
            onSelect={() => {
              useStore.getState().setFilter({ kind: 'folder', rootId, value: child.path, label: child.name });
              useStore.getState().setView('library');
            }}
          />
        ))}
    </>
  );
}
