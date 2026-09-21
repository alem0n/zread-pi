import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useWiki } from '@/hooks/useWiki';
import { orderedPages } from '@/utils/buildTree';

export function HomePage() {
  const { wikiData } = useWiki();
  const navigate = useNavigate();

  useEffect(() => {
    if (wikiData && wikiData.pages.length > 0) {
      // 落点是蓝图第一个分类的第一篇（pages 数组首项是并发完成顺序，不一定是第一篇）
      const first = orderedPages(wikiData)[0];
      if (first) navigate(`/${first.slug}`, { replace: true });
    }
  }, [wikiData, navigate]);

  return (
    <div className="flex items-center justify-center min-h-screen text-gray-500">
      加载中...
    </div>
  );
}
