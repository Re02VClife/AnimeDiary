import { useEffect, useState } from 'react';
import { getCachedCutoutIndex, loadCutoutIndex, subscribeCutoutIndex } from './cutout-service';

/**
 * 订阅「哪些角色已有去底立绘」。
 *
 * 卡片网格里每张卡都要判断一次，所以索引常驻内存、只拉一次；
 * 保存或撤销去底后由 cutout-service 通知所有已挂载的界面刷新。
 */
export function useCutoutIndex(): Set<string> {
  const [names, setNames] = useState<Set<string>>(() => getCachedCutoutIndex());

  useEffect(() => {
    let alive = true;
    const sync = () => { if (alive) setNames(new Set(getCachedCutoutIndex())); };
    const unsubscribe = subscribeCutoutIndex(() => {
      // 缓存刚被清空，重新拉一次再同步给界面
      void loadCutoutIndex(true).then(sync);
    });
    void loadCutoutIndex().then(sync);
    return () => { alive = false; unsubscribe(); };
  }, []);

  return names;
}
