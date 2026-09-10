import { useContext } from 'react';
import { TocContext } from '@/context/tocContext';

export function useTocContext() {
  const context = useContext(TocContext);
  if (!context) {
    throw new Error('useTocContext must be used within TocProvider');
  }
  return context;
}