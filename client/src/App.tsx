import type { ServerMessage } from '@claude-web-view/shared';
import { useEffect, useRef } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Chat } from './components/Chat';
import { ConfigDropdown } from './components/ConfigDropdown';
import { Gallery } from './components/Gallery';
import { RobotLoader } from './components/RobotLoader';
import { Sidebar } from './components/Sidebar';
import { SwarmAnalytics } from './components/SwarmAnalytics';
import { SwarmDashboard } from './components/SwarmDashboard';
import { SwarmDetail } from './components/SwarmDetail';
import { useWebSocket } from './hooks/useWebSocket';
import { useConversationStore } from './stores/conversationStore';
import { initSettings } from './stores/settingsStore';
import { useUIStore } from './stores/uiStore';
import './App.css';

/**
 * Connects the useWebSocket hook to the Zustand store.
 * Replaces the old AppProvider wrapper — no component tree needed.
 */
function useWebSocketBridge() {
  const handleMessage = useConversationStore((s) => s._handleMessage);
  const setSend = useConversationStore((s) => s._setSend);
  const setWsStatus = useConversationStore((s) => s._setWsStatus);

  const wsUrl = `ws://${window.location.host}/ws`;
  const { send, status } = useWebSocket<ServerMessage>(wsUrl, handleMessage);

  useEffect(() => {
    setSend(send);
  }, [send, setSend]);
  useEffect(() => {
    setWsStatus(status);
  }, [status, setWsStatus]);
}

/**
 * Restores the last active conversation on initial page load.
 * Lives in AppLayout (mounted once, never remounts) so the ref
 * persists across route changes. Only redirects if the user landed
 * on "/" — not if they're already on a /chat/:id deep link.
 *
 * BUG FIX: Previously lived in GalleryWithRestore which remounted
 * on every Gallery click, causing flash-redirect back to the last chat.
 */
function useRestoreOnLoad() {
  const navigate = useNavigate();
  const location = useLocation();
  const conversationsSize = useConversationStore((s) => s.conversations.size);
  const conversations = useConversationStore((s) => s.conversations);
  const savedActiveId = useUIStore((s) => s.activeConversationId);
  const didRestore = useRef(false);

  useEffect(() => {
    if (didRestore.current || conversationsSize === 0) return;
    didRestore.current = true;

    // Only restore if user landed on the gallery (root) URL.
    // If they deep-linked to /chat/:id or /done, respect that.
    if (location.pathname === '/' && savedActiveId && conversations.has(savedActiveId)) {
      navigate(`/chat/${savedActiveId}`, { replace: true });
    }
  }, [conversationsSize, conversations, navigate, savedActiveId, location.pathname]);
}

function AppLayout() {
  useWebSocketBridge();
  useRestoreOnLoad();

  // Initialize settings on mount — loads from server and applies saved palette
  useEffect(() => {
    initSettings().catch(console.error);
  }, []);

  return (
    <div className="app">
      <Sidebar />
      <div className="main-content">
        <div className="top-bar">
          <ConfigDropdown />
        </div>
        <Routes>
          <Route path="/" element={<Gallery />} />
          <Route path="/done" element={<Gallery filter="done" />} />
          <Route path="/workers" element={<SwarmDashboard />} />
          <Route path="/workers/detail" element={<SwarmDetail />} />
          <Route path="/workers/analytics" element={<SwarmAnalytics />} />
          <Route path="/chat/:id" element={<Chat />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/robot" element={<RobotLoader />} />
        <Route path="/*" element={<AppLayout />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
