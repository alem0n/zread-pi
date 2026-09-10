import { createContext } from 'react';

interface TocContextValue {
  activeId: string | null;
  registerHeading: (id: string) => void;
  unregisterHeading: (id: string) => void;
  setInView: (id: string, inView: boolean) => void;
}

export const TocContext = createContext<TocContextValue | null>(null);