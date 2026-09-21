import { useState, useCallback, useRef, useEffect } from 'react';
import { TocContext } from './tocContext';

export function TocProvider({ children }: { children: React.ReactNode }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const headingsRef = useRef<Set<string>>(new Set());
  const inViewHeadingsRef = useRef<Set<string>>(new Set());

  const recomputeActiveId = useCallback(() => {
    const ids = Array.from(headingsRef.current);
    if (ids.length === 0) return;

    const threshold = 24;
    let nextActive: string | null = null;
    let bestTop = -Infinity;
    let fallbackId: string | null = null;
    let fallbackTop = Infinity;

    ids.forEach((headingId) => {
      const element = document.getElementById(headingId);
      if (!element) return;

      const top = element.getBoundingClientRect().top;

      if (top <= threshold && top > bestTop) {
        bestTop = top;
        nextActive = headingId;
      }

      if (top > threshold && top < fallbackTop) {
        fallbackTop = top;
        fallbackId = headingId;
      }
    });

    setActiveId(nextActive ?? fallbackId ?? ids[0]);
  }, []);

  const registerHeading = useCallback((id: string) => {
    headingsRef.current.add(id);
  }, []);

  const unregisterHeading = useCallback((id: string) => {
    headingsRef.current.delete(id);
    inViewHeadingsRef.current.delete(id);
  }, []);

  const setInView = useCallback((id: string, inView: boolean) => {
    if (inView) {
      inViewHeadingsRef.current.add(id);
    } else {
      inViewHeadingsRef.current.delete(id);
    }

    recomputeActiveId();
  }, [recomputeActiveId]);

  useEffect(() => {
    recomputeActiveId();
  }, [recomputeActiveId]);

  return (
    <TocContext.Provider value={{ activeId, registerHeading, unregisterHeading, setInView }}>
      {children}
    </TocContext.Provider>
  );
}