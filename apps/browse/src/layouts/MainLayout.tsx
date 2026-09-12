// apps/browse/src/layouts/MainLayout.tsx
import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { ChatWidget } from '@/features/chat/ChatWidget';
import { CHAT_PANEL_DEFAULT_WIDTH } from '@/features/chat/chatState';
import { WikiSidebar } from '@/components/WikiSidebar';
import { resetScrollElementToTop } from '@/utils/scroll';

export function MainLayout() {
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [chatPanelWidth, setChatPanelWidth] = useState(CHAT_PANEL_DEFAULT_WIDTH);

  // 弹层（Radix Portal 挂在 body 下）继承不到包裹层 div 上的变量，
  // 因此把聊天面板宽度与开关状态提到 documentElement，
  // 供 mermaid 预览等全屏弹层让位（.mermaid-preview-content 等）。
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--chat-panel-width', `${chatPanelWidth}px`);
    root.style.setProperty('--chat-panel-open', chatCollapsed ? '0' : '1');
    return () => {
      root.style.removeProperty('--chat-panel-width');
      root.style.removeProperty('--chat-panel-open');
    };
  }, [chatPanelWidth, chatCollapsed]);

  useEffect(() => {
    resetScrollElementToTop(mainRef.current);
  }, [pathname]);

  return (
    <div className="flex h-screen bg-white overflow-hidden">
      <WikiSidebar />

      <main
        ref={mainRef}
        className={`flex-1 min-w-0 overflow-y-auto scroll-smooth chat-main ${
          chatCollapsed ? '' : 'chat-main-with-panel'
        }`}
      >
        <Outlet />
      </main>

      <ChatWidget
        panelWidth={chatPanelWidth}
        onCollapsedChange={setChatCollapsed}
        onPanelWidthChange={setChatPanelWidth}
      />
    </div>
  );
}
