import { useState, useEffect, useCallback } from 'react';

// Color palette definition
export interface ColorPalette {
  name: string;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    surface: string;
    text: string;
    textMuted: string;
    border: string;
    user: string;
    assistant: string;
  };
}

// Built-in palettes
export const PALETTES: Record<string, ColorPalette> = {
  solarized: {
    name: 'Solarized Dark',
    colors: {
      primary: '#268bd2',
      secondary: '#2aa198',
      accent: '#b58900',
      background: '#002b36',
      surface: '#073642',
      text: '#839496',
      textMuted: '#586e75',
      border: '#073642',
      user: '#268bd2',
      assistant: '#2aa198',
    },
  },
  nord: {
    name: 'Nord',
    colors: {
      primary: '#88c0d0',
      secondary: '#81a1c1',
      accent: '#ebcb8b',
      background: '#2e3440',
      surface: '#3b4252',
      text: '#eceff4',
      textMuted: '#d8dee9',
      border: '#4c566a',
      user: '#88c0d0',
      assistant: '#a3be8c',
    },
  },
  dracula: {
    name: 'Dracula',
    colors: {
      primary: '#bd93f9',
      secondary: '#ff79c6',
      accent: '#ffb86c',
      background: '#282a36',
      surface: '#44475a',
      text: '#f8f8f2',
      textMuted: '#6272a4',
      border: '#44475a',
      user: '#8be9fd',
      assistant: '#50fa7b',
    },
  },
  monokai: {
    name: 'Monokai',
    colors: {
      primary: '#66d9ef',
      secondary: '#a6e22e',
      accent: '#f92672',
      background: '#272822',
      surface: '#3e3d32',
      text: '#f8f8f2',
      textMuted: '#75715e',
      border: '#49483e',
      user: '#66d9ef',
      assistant: '#a6e22e',
    },
  },
  gruvbox: {
    name: 'Gruvbox Dark',
    colors: {
      primary: '#83a598',
      secondary: '#8ec07c',
      accent: '#fabd2f',
      background: '#282828',
      surface: '#3c3836',
      text: '#ebdbb2',
      textMuted: '#a89984',
      border: '#504945',
      user: '#83a598',
      assistant: '#b8bb26',
    },
  },
  tokyo: {
    name: 'Tokyo Night',
    colors: {
      primary: '#7aa2f7',
      secondary: '#bb9af7',
      accent: '#e0af68',
      background: '#1a1b26',
      surface: '#24283b',
      text: '#c0caf5',
      textMuted: '#565f89',
      border: '#414868',
      user: '#7aa2f7',
      assistant: '#9ece6a',
    },
  },
  catppuccin: {
    name: 'Catppuccin Mocha',
    colors: {
      primary: '#89b4fa',
      secondary: '#cba6f7',
      accent: '#f9e2af',
      background: '#1e1e2e',
      surface: '#313244',
      text: '#cdd6f4',
      textMuted: '#6c7086',
      border: '#45475a',
      user: '#89b4fa',
      assistant: '#a6e3a1',
    },
  },
};

export interface Settings {
  colorPalette: string; // Key into PALETTES
}

const DEFAULT_SETTINGS: Settings = {
  colorPalette: 'solarized',
};

// Apply palette to CSS variables
export function applyPalette(palette: ColorPalette) {
  const root = document.documentElement;
  root.style.setProperty('--color-primary', palette.colors.primary);
  root.style.setProperty('--color-secondary', palette.colors.secondary);
  root.style.setProperty('--color-accent', palette.colors.accent);
  root.style.setProperty('--color-background', palette.colors.background);
  root.style.setProperty('--color-surface', palette.colors.surface);
  root.style.setProperty('--color-text', palette.colors.text);
  root.style.setProperty('--color-text-muted', palette.colors.textMuted);
  root.style.setProperty('--color-border', palette.colors.border);
  root.style.setProperty('--color-user', palette.colors.user);
  root.style.setProperty('--color-assistant', palette.colors.assistant);
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  // Load settings from server on mount
  useEffect(() => {
    fetch('/api/settings')
      .then((res) => res.json())
      .then((data) => {
        if (data && data.colorPalette) {
          setSettings(data);
        }
        setLoaded(true);
      })
      .catch(() => {
        // Settings endpoint might not exist, use defaults
        setLoaded(true);
      });
  }, []);

  // Apply palette when settings change
  useEffect(() => {
    if (loaded) {
      const palette = PALETTES[settings.colorPalette] || PALETTES.solarized;
      applyPalette(palette);
    }
  }, [settings.colorPalette, loaded]);

  const updateSettings = useCallback((newSettings: Partial<Settings>) => {
    setSettings((prev) => {
      const updated = { ...prev, ...newSettings };
      // Save to server
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      }).catch(console.error);
      return updated;
    });
  }, []);

  const setColorPalette = useCallback(
    (paletteKey: string) => {
      updateSettings({ colorPalette: paletteKey });
    },
    [updateSettings]
  );

  // Preview a palette without saving
  const previewPalette = useCallback((paletteKey: string) => {
    const palette = PALETTES[paletteKey];
    if (palette) {
      applyPalette(palette);
    }
  }, []);

  // Restore current saved palette (after preview)
  const restorePalette = useCallback(() => {
    const palette = PALETTES[settings.colorPalette] || PALETTES.solarized;
    applyPalette(palette);
  }, [settings.colorPalette]);

  return {
    settings,
    setColorPalette,
    previewPalette,
    restorePalette,
    loaded,
  };
}
