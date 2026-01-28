import { useCallback, useEffect, useRef, useState } from 'react';

type Status = 'connecting' | 'connected' | 'disconnected';

export function useWebSocket<T = unknown>(url: string, onMessage: (data: T) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMounted = useRef(true);
  const isIntentionalClose = useRef(false);
  // STABILITY FIX: Use ref for callback to avoid reconnecting when callback changes.
  // Without this, any state change that causes handleMessage to be recreated
  // (like activeConversationId) would cause WebSocket to disconnect/reconnect.
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    // Don't connect if already connected or connecting
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (wsRef.current?.readyState === WebSocket.CONNECTING) return;

    setStatus('connecting');
    const ws = new WebSocket(url);

    ws.onopen = () => {
      if (isMounted.current) {
        console.log('WebSocket connected');
        setStatus('connected');
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessageRef.current(data);
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };

    ws.onclose = () => {
      if (isMounted.current && !isIntentionalClose.current) {
        console.log('WebSocket disconnected, reconnecting...');
        setStatus('disconnected');
        // Reconnect after 2 seconds
        reconnectTimeout.current = window.setTimeout(() => {
          if (isMounted.current) {
            connect();
          }
        }, 2000);
      }
    };

    ws.onerror = (error) => {
      if (isMounted.current) {
        console.error('WebSocket error:', error);
      }
    };

    wsRef.current = ws;
  }, [url]); // Only reconnect when URL changes, not when callback changes

  useEffect(() => {
    isMounted.current = true;
    isIntentionalClose.current = false;
    connect();

    return () => {
      isMounted.current = false;
      isIntentionalClose.current = true;
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    } else {
      console.warn('WebSocket not connected');
    }
  }, []);

  return { send, status };
}
