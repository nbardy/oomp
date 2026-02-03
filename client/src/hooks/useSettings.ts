import { useState, useEffect, useCallback, useMemo } from 'react';

/**
 * 16-token palette. The only source of truth for a theme.
 * CSS derives all other tokens (~60+) from these 14 values via color-mix().
 *
 * Naming follows Solarized convention:
 *   base03 = darkest background, base02 = surface bg,
 *   base01 = muted text, base00 = secondary text,
 *   base0 = primary text, base1 = emphasis text,
 *   + 8 accent colors
 */
export interface Palette16 {
  name: string;
  base03: string;
  base02: string;
  base01: string;
  base00: string;
  base0:  string;
  base1:  string;
  yellow:  string;
  orange:  string;
  red:     string;
  magenta: string;
  violet:  string;
  blue:    string;
  cyan:    string;
  green:   string;
}

// Built-in palettes mapped to Palette16 format
export const PALETTES: Record<string, Palette16> = {
  solarized: {
    name: 'Solarized Dark',
    base03: '#002b36', base02: '#073642',
    base01: '#586e75', base00: '#657b83',
    base0:  '#839496', base1:  '#93a1a1',
    yellow: '#b58900', orange: '#cb4b16',
    red:    '#dc322f', magenta:'#d33682',
    violet: '#6c71c4', blue:   '#268bd2',
    cyan:   '#2aa198', green:  '#859900',
  },
  oksolar: {
    name: 'OKSolar Dark',
    base03: '#002d38', base02: '#093946',
    base01: '#5b7279', base00: '#657377',
    base0:  '#98a8a8', base1:  '#8faaab',
    yellow: '#ac8300', orange: '#d56500',
    red:    '#f23749', magenta:'#dd459d',
    violet: '#7d80d1', blue:   '#2b90d8',
    cyan:   '#259d94', green:  '#819500',
  },
  nord: {
    name: 'Nord',
    base03: '#2e3440', base02: '#3b4252',
    base01: '#4c566a', base00: '#d8dee9',
    base0:  '#e5e9f0', base1:  '#eceff4',
    yellow: '#ebcb8b', orange: '#d08770',
    red:    '#bf616a', magenta:'#b48ead',
    violet: '#5e81ac', blue:   '#81a1c1',
    cyan:   '#88c0d0', green:  '#a3be8c',
  },
  dracula: {
    name: 'Dracula',
    base03: '#282a36', base02: '#44475a',
    base01: '#6272a4', base00: '#bfbfbf',
    base0:  '#f8f8f2', base1:  '#ffffff',
    yellow: '#f1fa8c', orange: '#ffb86c',
    red:    '#ff5555', magenta:'#ff79c6',
    violet: '#bd93f9', blue:   '#8be9fd',
    cyan:   '#8be9fd', green:  '#50fa7b',
  },
  monokai: {
    name: 'Monokai',
    base03: '#272822', base02: '#3e3d32',
    base01: '#75715e', base00: '#a6a086',
    base0:  '#f8f8f2', base1:  '#f8f8f0',
    yellow: '#e6db74', orange: '#fd971f',
    red:    '#f92672', magenta:'#f92672',
    violet: '#ae81ff', blue:   '#66d9ef',
    cyan:   '#66d9ef', green:  '#a6e22e',
  },
  gruvbox: {
    name: 'Gruvbox Dark',
    base03: '#282828', base02: '#3c3836',
    base01: '#504945', base00: '#a89984',
    base0:  '#ebdbb2', base1:  '#fbf1c7',
    yellow: '#fabd2f', orange: '#fe8019',
    red:    '#fb4934', magenta:'#d3869b',
    violet: '#d3869b', blue:   '#83a598',
    cyan:   '#8ec07c', green:  '#b8bb26',
  },
  tokyo: {
    name: 'Tokyo Night',
    base03: '#1a1b26', base02: '#24283b',
    base01: '#414868', base00: '#565f89',
    base0:  '#a9b1d6', base1:  '#c0caf5',
    yellow: '#e0af68', orange: '#ff9e64',
    red:    '#f7768e', magenta:'#bb9af7',
    violet: '#7aa2f7', blue:   '#7dcfff',
    cyan:   '#7dcfff', green:  '#9ece6a',
  },
  catppuccin: {
    name: 'Catppuccin Mocha',
    base03: '#1e1e2e', base02: '#313244',
    base01: '#45475a', base00: '#6c7086',
    base0:  '#cdd6f4', base1:  '#bac2de',
    yellow: '#f9e2af', orange: '#fab387',
    red:    '#f38ba8', magenta:'#cba6f7',
    violet: '#89b4fa', blue:   '#89dceb',
    cyan:   '#94e2d5', green:  '#a6e3a1',
  },
};

export interface Settings {
  colorPalette: string; // Key into PALETTES
}

const DEFAULT_SETTINGS: Settings = {
  colorPalette: 'solarized',
};

/**
 * Apply a Palette16 to CSS by setting 14 --pal-* custom properties.
 * CSS color-mix() rules derive the remaining ~60 tokens automatically.
 */
const PALETTE_KEYS = [
  'base03', 'base02', 'base01', 'base00', 'base0', 'base1',
  'yellow', 'orange', 'red', 'magenta', 'violet', 'blue', 'cyan', 'green',
] as const;

export function applyPalette(palette: Palette16) {
  const root = document.documentElement;
  for (const key of PALETTE_KEYS) {
    root.style.setProperty(`--pal-${key}`, palette[key]);
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [customPalettes, setCustomPalettes] = useState<Record<string, Palette16>>({});

  // Single merged palette map -- computed once, stable reference until customPalettes changes
  const allPalettes = useMemo<Record<string, Palette16>>(
    () => ({ ...PALETTES, ...customPalettes }),
    [customPalettes]
  );

  // Load settings and custom palettes from server on mount
  useEffect(() => {
    Promise.all([
      fetch('/api/settings').then((res) => res.json()),
      fetch('/api/custom-palettes').then((res) => res.json()),
    ])
      .then(([settingsData, palettesData]) => {
        if (settingsData && settingsData.colorPalette) {
          setSettings(settingsData);
        }
        if (palettesData && typeof palettesData === 'object') {
          setCustomPalettes(palettesData as Record<string, Palette16>);
        }
        setLoaded(true);
      })
      .catch(() => {
        setLoaded(true);
      });
  }, []);

  // Apply palette when settings or palette registry changes
  useEffect(() => {
    if (loaded) {
      const palette = allPalettes[settings.colorPalette] || PALETTES.solarized;
      applyPalette(palette);
    }
  }, [settings.colorPalette, loaded, allPalettes]);

  const updateSettings = useCallback((newSettings: Partial<Settings>) => {
    setSettings((prev) => {
      const updated = { ...prev, ...newSettings };
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

  // Optimistically add a newly generated custom palette without re-fetching
  const addCustomPalette = useCallback((key: string, palette: Palette16) => {
    setCustomPalettes((prev) => ({ ...prev, [key]: palette }));
  }, []);

  // Preview a palette without saving -- uses allPalettes via closure
  const previewPalette = useCallback((paletteKey: string) => {
    const palette = allPalettes[paletteKey];
    if (palette) {
      applyPalette(palette);
    }
  }, [allPalettes]);

  // Restore current saved palette (after preview)
  const restorePalette = useCallback(() => {
    const palette = allPalettes[settings.colorPalette] || PALETTES.solarized;
    applyPalette(palette);
  }, [settings.colorPalette, allPalettes]);

  return {
    settings,
    setColorPalette,
    previewPalette,
    restorePalette,
    addCustomPalette,
    allPalettes,
    loaded,
  };
}
