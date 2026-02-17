import React, { useMemo, useState, useCallback } from 'react';

// 中文注释：通用悬浮目录组件。接受章节列表，支持高亮当前小节、折叠与返回顶部。

export interface SectionItem {
  id: string; // 对应页面中小节容器的 DOM id
  title: string; // 在目录中显示的标题文案
}

interface FloatingSectionNavProps {
  sections: SectionItem[];
  activeId?: string | null;
  className?: string;
  onItemClick?: (id: string) => void;
}

export const FloatingSectionNav: React.FC<FloatingSectionNavProps> = ({ sections, activeId, className, onItemClick }) => {
  // 折叠状态
  const [collapsed, setCollapsed] = useState(false);

  const handleClick = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      // 使用平滑滚动到目标小节
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    onItemClick?.(id);
  }, [onItemClick]);

  const handleBackToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const navItems = useMemo(() => sections.filter(s => !!s && !!s.id), [sections]);

  return (
    <aside
      className={
        `hidden lg:block fixed right-2 top-24 z-40 w-[120px] max-h-[calc(100vh-8rem)] overflow-hidden ` +
        `rounded-xl border border-slate-200 bg-white/95 backdrop-blur-sm shadow-xl ${className ?? ''}`
      }
      aria-label="页面小节导航"
    >
      {/* 头部：标题 + 折叠按钮 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 bg-white/80">
        <div className="text-sm font-semibold text-slate-700">目录</div>
        <button
          type="button"
          className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50"
          onClick={() => setCollapsed(v => !v)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开目录' : '折叠目录'}
        >
          {collapsed ? '展开' : '折叠'}
        </button>
      </div>

      {/* 目录项 */}
      {!collapsed && (
        <div className="max-h-[calc(100vh-14rem)] overflow-auto p-2">
          <ul role="list" className="space-y-1">
            {navItems.map((s) => {
              const isActive = s.id === activeId;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => handleClick(s.id)}
                    className={
                      `w-full text-left text-[12px] px-2 py-1.5 rounded truncate ` +
                      (isActive
                        ? 'bg-blue-50 text-blue-700 border border-blue-200'
                        : 'text-slate-700 hover:bg-slate-50 border border-transparent')
                    }
                    aria-current={isActive ? 'true' : undefined}
                    title={s.title}
                  >
                    {s.title}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* 底部：返回顶部 */}
      <div className="px-3 py-2 border-t border-slate-200 bg-white/80 flex items-center justify-end">
        <button
          type="button"
          className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50"
          onClick={handleBackToTop}
        >
          返回顶部
        </button>
      </div>
    </aside>
  );
};

export default FloatingSectionNav;
