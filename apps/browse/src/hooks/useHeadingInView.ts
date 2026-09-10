import { useEffect } from 'react';
import { useInView } from 'react-intersection-observer';
import { useTocContext } from '@/hooks/useTocContext';

export function useHeadingInView(id: string) {
  const { registerHeading, unregisterHeading, setInView } = useTocContext();

  const { ref, inView } = useInView({
    threshold: 0,
    rootMargin: '0px',
  });

  useEffect(() => {
    registerHeading(id);
    return () => unregisterHeading(id);
  }, [id, registerHeading, unregisterHeading]);

  useEffect(() => {
    setInView(id, inView);
  }, [id, inView, setInView]);

  return ref;
}