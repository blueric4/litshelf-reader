/**
 * 库视图：三栏（侧边栏 / 列表 / 详情），中间两条可拖拽分隔线。
 */
import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../state/store';
import { Sidebar } from '../components/Sidebar';
import { ListPane } from '../components/ListPane';
import { DetailPane } from '../components/DetailPane';

export function LibraryView({ showDetail }: { showDetail: boolean }) {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const dragging = useRef<null | 'sidebar' | 'list'>(null);

  const onMouseDown = useCallback(
    (which: 'sidebar' | 'list') => (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = which;
      document.body.style.cursor = 'col-resize';
      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        if (dragging.current === 'sidebar') {
          const next = Math.min(420, Math.max(180, ev.clientX));
          updateSettings({ sidebarWidth: next });
        } else {
          const sidebar = useStore.getState().settings.sidebarWidth;
          const next = Math.min(680, Math.max(300, ev.clientX - sidebar));
          updateSettings({ listWidth: next });
        }
      };
      const onUp = () => {
        dragging.current = null;
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [updateSettings],
  );

  // 拖拽时避免选中文字
  useEffect(() => {
    const prevent = (e: Event) => {
      if (dragging.current) e.preventDefault();
    };
    window.addEventListener('selectstart', prevent);
    return () => window.removeEventListener('selectstart', prevent);
  }, []);

  return (
    <div
      className={`app-body${showDetail ? '' : ' no-detail'}`}
      style={{ ['--sidebar-w' as string]: `${settings.sidebarWidth}px`, ['--list-w' as string]: `${settings.listWidth}px` }}
    >
      <Sidebar />
      <div className="resizer" onMouseDown={onMouseDown('sidebar')} />
      <ListPane />
      {showDetail ? (
        <>
          <div className="resizer" onMouseDown={onMouseDown('list')} />
          <DetailPane />
        </>
      ) : null}
    </div>
  );
}
