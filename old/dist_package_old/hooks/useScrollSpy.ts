import { useEffect, useState } from 'react';

// 中文注释：滚动侦测 Hook，根据视图滚动计算当前所在小节 id。
// 策略：基于每个目标元素相对视口顶部的位置，取“顶部阈值内的最后一个小节”为当前高亮。

interface Options {
  /** 顶部阈值（像素），默认 120px。超过该阈值才算进入该小节 */
  topThreshold?: number;
}

export function useScrollSpy(ids: string[], options?: Options) {
  const topThreshold = options?.topThreshold ?? 120;
  const [activeId, setActiveId] = useState<string | null>(ids[0] ?? null);

  useEffect(() => {
    if (!ids || ids.length === 0) {
      setActiveId(null);
      return;
    }

    let ticking = false;

    const calc = () => {
      ticking = false;
      let current: string | null = ids[0] ?? null;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const el = document.getElementById(id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top - topThreshold <= 0) {
          current = id; // 记录最后一个越过阈值的元素
        } else {
          break; // 后续更靠下，直接退出
        }
      }
      setActiveId(current);
    };

    const onScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(calc);
        ticking = true;
      }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    // 初始计算
    calc();

    return () => {
      window.removeEventListener('scroll', onScroll as any);
      window.removeEventListener('resize', onScroll as any);
    };
  }, [ids.join('|'), topThreshold]);

  return activeId;
}

export default useScrollSpy;

