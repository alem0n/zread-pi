// apps/browse/src/App.tsx
import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { WikiProvider } from '@/context/WikiContext';
import { useWiki } from '@/hooks/useWiki';
import { MainLayout } from '@/layouts/MainLayout';
import { HomePage, WikiPage, TrajectoryPage } from '@/pages';
import '@/index.css';

function AppRoutes() {
  const { loadWikiData } = useWiki();

  useEffect(() => {
    loadWikiData();
  }, [loadWikiData]);

  return (
    <Routes>
      {/* 轨迹页全宽独立布局，不进 MainLayout */}
      <Route path="/trajectory" element={<TrajectoryPage />} />
      <Route path="/trajectory/:runId" element={<TrajectoryPage />} />
      <Route element={<MainLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/:slug" element={<WikiPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function App() {
  return (
    <BrowserRouter>
      <WikiProvider>
        <AppRoutes />
      </WikiProvider>
    </BrowserRouter>
  );
}

export default App;
