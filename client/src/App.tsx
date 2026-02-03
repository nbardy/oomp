import { useEffect, useRef } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import type { ServerMessage } from '@claude-web-view/shared';
import { Chat } from './components/Chat';
import { Gallery } from './components/Gallery';
import { Sidebar } from './components/Sidebar';
import { ConfigDropdown } from './components/ConfigDropdown';
import { RobotLoader } from './components/RobotLoader';
import { useWebSocket } from './hooks/useWebSocket';
import { useConversationStore } from './stores/conversationStore';
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

  useEffect(() => { setSend(send); }, [send, setSend]);
  useEffect(() => { setWsStatus(status); }, [status, setWsStatus]);
}

/**
 * Restores the last active conversation tab on page load.
 * Waits for the init WebSocket message to populate conversations,
 * then navigates to the saved ID if it still exists. Fires only once.
 */
function GalleryWithRestore() {
  const navigate = useNavigate();
  const conversationsSize = useConversationStore((s) => s.conversations.size);
  const conversations = useConversationStore((s) => s.conversations);
  const didRestore = useRef(false);

  const savedActiveId = useUIStore((s) => s.activeConversationId);

  useEffect(() => {
    if (didRestore.current || conversationsSize === 0) return;
    didRestore.current = true;

    if (savedActiveId && conversations.has(savedActiveId)) {
      navigate(`/chat/${savedActiveId}`, { replace: true });
    }
  }, [conversationsSize, conversations, navigate, savedActiveId]);

  return <Gallery />;
}

function AppLayout() {
  useWebSocketBridge();

  return (
    <div className="app">
      <Sidebar />
      <div className="main-content">
        <div className="top-bar">
          <ConfigDropdown />
        </div>
        <Routes>
          <Route path="/" element={<GalleryWithRestore />} />
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
