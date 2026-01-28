import type { Provider } from '@claude-web-view/shared';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import './Sidebar.css';

export function Sidebar() {
  const {
    conversations,
    activeConversationId,
    createConversation,
    deleteConversation,
    defaultCwd,
    wsStatus,
  } = useApp();
  const [showPicker, setShowPicker] = useState(false);
  const [directory, setDirectory] = useState('');
  const [provider, setProvider] = useState<Provider>('claude');
  const [pendingNav, setPendingNav] = useState(false);
  const prevConvCount = useRef(conversations.size);
  const navigate = useNavigate();
  const location = useLocation();

  // Navigate to new conversation when it's created
  useEffect(() => {
    if (pendingNav && conversations.size > prevConvCount.current) {
      // Find the newest conversation (last one added)
      const convArray = Array.from(conversations.values());
      const newest = convArray[convArray.length - 1];
      if (newest) {
        navigate(`/chat/${newest.id}`);
        setPendingNav(false);
      }
    }
    prevConvCount.current = conversations.size;
  }, [conversations.size, pendingNav, navigate, conversations]);

  const handleNewConversation = () => {
    // Use last saved directory, or server's cwd, or a placeholder
    const lastDir = localStorage.getItem('claudeWorkingDirectory') || defaultCwd || '/';
    setDirectory(lastDir);
    setShowPicker(true);
  };

  const handleConfirm = () => {
    if (directory.trim()) {
      localStorage.setItem('claudeWorkingDirectory', directory);
      setPendingNav(true);
      createConversation(directory, provider);
      setShowPicker(false);
    }
  };

  const handleCancel = () => {
    setShowPicker(false);
  };

  const handleSelectConversation = (id: string) => {
    navigate(`/chat/${id}`);
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Delete this conversation?')) {
      deleteConversation(id);
      if (location.pathname.includes(id)) {
        navigate('/');
      }
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button type="button" className="gallery-btn" onClick={() => navigate('/')}>
          <span>◫</span>
          <span>Gallery</span>
        </button>
        <button type="button" className="new-chat-btn" onClick={handleNewConversation}>
          <span>+</span>
          <span>New Conversation</span>
        </button>

        {showPicker && (
          <div className="directory-picker">
            <input
              type="text"
              className="directory-input"
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder="/path/to/directory"
            />
            <div className="provider-selector">
              <label className={`provider-option ${provider === 'claude' ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="provider"
                  value="claude"
                  checked={provider === 'claude'}
                  onChange={() => setProvider('claude')}
                />
                Claude
              </label>
              <label className={`provider-option ${provider === 'codex' ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="provider"
                  value="codex"
                  checked={provider === 'codex'}
                  onChange={() => setProvider('codex')}
                />
                Codex
              </label>
            </div>
            <div className="directory-actions">
              <button
                type="button"
                className="dir-action-btn dir-confirm-btn"
                onClick={handleConfirm}
                disabled={wsStatus !== 'connected'}
                title={wsStatus !== 'connected' ? 'Server disconnected' : 'Create conversation'}
              >
                ✓
              </button>
              <button
                type="button"
                className="dir-action-btn dir-cancel-btn"
                onClick={handleCancel}
              >
                ✕
              </button>
            </div>
          </div>
        )}

        <div className="ws-status">
          <span className={`status-dot ${wsStatus}`} />
          {wsStatus}
        </div>
      </div>

      <div className="conversations-list">
        {Array.from(conversations.values()).map((conv) => {
          const isActive = conv.id === activeConversationId;
          const dirDisplay = conv.workingDirectory.replace(/^\/Users\/[^/]+/, '~');
          const preview =
            conv.messages.length > 0
              ? `${conv.messages[conv.messages.length - 1].content.substring(0, 50)}...`
              : 'New conversation';

          return (
            <div
              key={conv.id}
              className={`conversation-item ${isActive ? 'active' : ''}`}
              onClick={() => handleSelectConversation(conv.id)}
            >
              <div className="conversation-header">
                <div className="conversation-id">{conv.id.substring(0, 8)}</div>
                <div className={`status-indicator ${conv.isRunning ? 'running' : ''}`} />
              </div>
              <div className="conversation-preview">{preview}</div>
              <div className="conversation-dir">{dirDisplay}</div>
              <button
                type="button"
                className="delete-btn"
                onClick={(e) => handleDelete(conv.id, e)}
              >
                Delete
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
