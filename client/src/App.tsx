import type { ServerMessage } from '@orchestral/shared';
import { Provider, useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { handleMessage, setSendFn, setWsStatus } from './atoms/actions';
import { allConversationsAtom, conversationsAtom } from './atoms/conversations';
import { jotaiStore } from './atoms/store';
import { Chat } from './components/Chat';
import { ConfigDropdown } from './components/ConfigDropdown';
import { Gallery } from './components/Gallery';
import { RobotLoader } from './components/RobotLoader';
import { Sidebar } from './components/Sidebar';
import { SwarmAnalytics } from './components/SwarmAnalytics';
import { SwarmDashboard } from './components/SwarmDashboard';
import { SwarmDetail } from './components/SwarmDetail';
import { useWebSocket } from './hooks/useWebSocket';
import { initSettings } from './stores/settingsStore';
import { useUIStore } from './stores/uiStore';
import './App.css';
import { AgentAuditOverlay } from './components/AgentAuditOverlay';

/**
 * Connects the useWebSocket hook to the Jotai atom store.
 * handleMessage, setSendFn, setWsStatus are plain functions — no store selectors needed.
 */
function useWebSocketBridge() {
  const wsUrl = `ws://${window.location.host}/ws`;
  const { send, status } = useWebSocket<ServerMessage>(wsUrl, handleMessage);

  useEffect(() => {
    setSendFn(send);
  }, [send]);

  useEffect(() => {
    setWsStatus(status);
  }, [status]);
}

/**
 * Restores the last active conversation on initial page load.
 */
function useRestoreOnLoad() {
  const navigate = useNavigate();
  const location = useLocation();
  const allConversations = useAtomValue(allConversationsAtom);
  const savedActiveId = useUIStore((s) => s.activeConversationId);
  const didRestore = useRef(false);

  useEffect(() => {
    if (didRestore.current || allConversations.length === 0) return;
    didRestore.current = true;

    if (location.pathname === '/' && savedActiveId) {
      const conversations = jotaiStore.get(conversationsAtom);
      if (conversations.has(savedActiveId)) {
        navigate(`/chat/${savedActiveId}`, { replace: true });
      }
    }
  }, [allConversations.length, navigate, savedActiveId, location.pathname]);
}

function AppLayout() {
  useWebSocketBridge();
  useRestoreOnLoad();

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
    <Provider store={jotaiStore}>
      <BrowserRouter>
        <AgentAuditOverlay />
        <Routes>
          <Route path="/robot" element={<RobotLoader />} />
          <Route path="/*" element={<AppLayout />} />
        </Routes>
      </BrowserRouter>
    </Provider>
  );
}

export default App;
