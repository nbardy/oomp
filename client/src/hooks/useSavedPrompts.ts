import { useCallback, useEffect, useState } from 'react';

interface SavedPrompt {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  usageCount: number;
}

const STORAGE_KEY = 'claude-saved-prompts';

function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

export function useSavedPrompts() {
  const [prompts, setPrompts] = useState<SavedPrompt[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
  }, [prompts]);

  const savePrompt = useCallback((content: string, name?: string) => {
    const prompt: SavedPrompt = {
      id: generateId(),
      name: name || content.substring(0, 50),
      content,
      createdAt: new Date().toISOString(),
      usageCount: 0,
    };
    setPrompts((prev) => [prompt, ...prev]);
    return prompt;
  }, []);

  const deletePrompt = useCallback((id: string) => {
    setPrompts((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const incrementUsage = useCallback((id: string) => {
    setPrompts((prev) =>
      prev.map((p) => (p.id === id ? { ...p, usageCount: p.usageCount + 1 } : p))
    );
  }, []);

  const fuzzySearch = useCallback(
    (query: string): SavedPrompt[] => {
      const sorted = [...prompts].sort((a, b) => b.usageCount - a.usageCount);
      if (!query) return sorted;
      const lower = query.toLowerCase();
      return sorted.filter(
        (p) => p.name.toLowerCase().includes(lower) || p.content.toLowerCase().includes(lower)
      );
    },
    [prompts]
  );

  return { prompts, savePrompt, deletePrompt, incrementUsage, fuzzySearch };
}
