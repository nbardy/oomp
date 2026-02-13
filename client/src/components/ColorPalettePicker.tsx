import { useRef, useState } from 'react';
import { useSettingsStore, PALETTES, applyPalette, type Palette16 } from '../stores/settingsStore';
import './ColorPalettePicker.css';

interface Props {
  onClose: () => void;
}

// ─── Color math helpers ──────────────────────────────────────────────────────
// These replicate the CSS color-mix(in oklch, ...) derivations in JS so we can
// render computed swatches in the picker. The formulas match index.css exactly.

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
}

// sRGB → linear
function linearize(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

// linear → sRGB
function delinearize(c: number): number {
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return s * 255;
}

function rgbToOklch(r: number, g: number, b: number): [number, number, number] {
  const lr = linearize(r);
  const lg = linearize(g);
  const lb = linearize(b);

  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l1 = Math.cbrt(l_);
  const m1 = Math.cbrt(m_);
  const s1 = Math.cbrt(s_);

  const L = 0.2104542553 * l1 + 0.7936177850 * m1 - 0.0040720468 * s1;
  const a = 1.9779984951 * l1 - 2.4285922050 * m1 + 0.4505937099 * s1;
  const bVal = 0.0259040371 * l1 + 0.7827717662 * m1 - 0.8086757660 * s1;

  const C = Math.sqrt(a * a + bVal * bVal);
  let H = Math.atan2(bVal, a) * (180 / Math.PI);
  if (H < 0) H += 360;

  return [L, C, H];
}

function oklchToRgb(L: number, C: number, H: number): [number, number, number] {
  const hRad = H * (Math.PI / 180);
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  const l1 = L + 0.3963377774 * a + 0.2158037573 * b;
  const m1 = L - 0.1055613458 * a - 0.0638541728 * b;
  const s1 = L - 0.0894841775 * a - 1.2914855480 * b;

  const l_ = l1 * l1 * l1;
  const m_ = m1 * m1 * m1;
  const s_ = s1 * s1 * s1;

  const r = +4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
  const bVal = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_;

  return [delinearize(r), delinearize(g), delinearize(bVal)];
}

/** Simulate color-mix(in oklch, color P%, black) */
function mixBlackOklch(hex: string, pct: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [L, C, H] = rgbToOklch(r, g, b);
  const [rr, gg, bb] = oklchToRgb(L * (pct / 100), C * (pct / 100), H);
  return rgbToHex(rr, gg, bb);
}

/** Simulate color-mix(in oklch, color P%, white) */
function mixWhiteOklch(hex: string, pct: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [L, C, H] = rgbToOklch(r, g, b);
  const wt = 1 - pct / 100;
  const [rr, gg, bb] = oklchToRgb(L + (1 - L) * wt, C * (pct / 100), H);
  return rgbToHex(rr, gg, bb);
}

/** Simulate color-mix(in srgb, color P%, transparent) → rgba string */
function mixTransparentSrgb(hex: string, pct: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${(pct / 100).toFixed(2)})`;
}

/** Simulate color-mix(in oklch, colorA P%, colorB) */
function mixTwoOklch(hexA: string, hexB: string, pctA: number): string {
  const [rA, gA, bA] = hexToRgb(hexA);
  const [rB, gB, bB] = hexToRgb(hexB);
  const [lA, cA, hA] = rgbToOklch(rA, gA, bA);
  const [lB, cB, hB] = rgbToOklch(rB, gB, bB);
  const t = pctA / 100;
  // Hue interpolation (shortest arc)
  let dh = hB - hA;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  const h = hA + (1 - t) * dh;
  const [r, g, b] = oklchToRgb(lA * t + lB * (1 - t), cA * t + cB * (1 - t), h);
  return rgbToHex(r, g, b);
}

// ─── Derived token computation from a Palette16 ─────────────────────────────
// Mirrors index.css :root derivations exactly.

interface DerivedTokens {
  // Accent families: 8 colors × 4 variants
  accents: Record<string, { dim: string; base: string; bright: string; glow: string }>;
  // Background elevation ramp
  bg: { label: string; color: string }[];
  // Text scale
  text: { label: string; color: string }[];
  // Border scale
  borders: { label: string; color: string }[];
  // Semantic mappings
  semantic: { label: string; color: string; accent: string }[];
  // Message tints
  messages: { label: string; color: string }[];
}

const ACCENT_KEYS = ['blue', 'cyan', 'violet', 'green', 'yellow', 'orange', 'red', 'magenta'] as const;

const SEMANTIC_MAP: { label: string; key: typeof ACCENT_KEYS[number] }[] = [
  { label: 'Primary', key: 'violet' },
  { label: 'User', key: 'blue' },
  { label: 'Assistant', key: 'cyan' },
  { label: 'Success', key: 'cyan' },
  { label: 'Warning', key: 'yellow' },
  { label: 'Error', key: 'red' },
  { label: 'Queue', key: 'orange' },
  { label: 'Loop', key: 'magenta' },
];

function derivePalette(p: Palette16): DerivedTokens {
  const accents: DerivedTokens['accents'] = {};
  for (const key of ACCENT_KEYS) {
    accents[key] = {
      dim: mixBlackOklch(p[key], 65),
      base: p[key],
      bright: mixWhiteOklch(p[key], 75),
      glow: mixTransparentSrgb(p[key], 22),
    };
  }

  const bg: DerivedTokens['bg'] = [
    { label: 'Darkest', color: mixBlackOklch(p.base03, 70) },
    { label: 'Base', color: mixBlackOklch(p.base03, 85) },
    { label: 'Content', color: p.base03 },
    { label: 'Card', color: mixTwoOklch(p.base03, p.base02, 85) },
    { label: 'Panel', color: p.base02 },
    { label: 'Hover', color: mixTwoOklch(p.base02, p.base01, 80) },
    { label: 'Active', color: mixTwoOklch(p.base02, p.base01, 65) },
    { label: 'Popup', color: mixTwoOklch(p.base02, p.base01, 50) },
    { label: 'Highlight', color: mixTwoOklch(p.base02, p.base01, 35) },
  ];

  const text: DerivedTokens['text'] = [
    { label: 'Muted', color: p.base01 },
    { label: 'Secondary', color: p.base00 },
    { label: 'Primary', color: p.base0 },
    { label: 'Emphasis', color: p.base1 },
    { label: 'Bright', color: mixWhiteOklch(p.base1, 70) },
  ];

  const borders: DerivedTokens['borders'] = [
    { label: 'Subtle (10%)', color: mixTransparentSrgb(p.base1, 10) },
    { label: 'Default (18%)', color: mixTransparentSrgb(p.base1, 18) },
    { label: 'Emphasis (28%)', color: mixTransparentSrgb(p.base1, 28) },
    { label: 'Strong (42%)', color: mixTransparentSrgb(p.base1, 42) },
  ];

  const semantic: DerivedTokens['semantic'] = SEMANTIC_MAP.map(({ label, key }) => ({
    label,
    color: p[key],
    accent: key,
  }));

  // Message tints: 8% accent mixed into base03
  const messages: DerivedTokens['messages'] = [
    { label: 'User', color: mixTwoOklch(p.blue, p.base03, 8) },
    { label: 'Assistant', color: mixTwoOklch(p.cyan, p.base03, 8) },
    { label: 'System', color: mixTwoOklch(p.yellow, p.base03, 8) },
    { label: 'Error', color: mixTwoOklch(p.red, p.base03, 8) },
  ];

  return { accents, bg, text, borders, semantic, messages };
}

// ─── Picker sections ─────────────────────────────────────────────────────────

/** Horizontal strip: dim → base → bright → glow for one accent */
function AccentStrip({ name, family }: { name: string; family: DerivedTokens['accents'][string] }) {
  return (
    <div className="accent-strip">
      <span className="strip-label">{name}</span>
      <div className="strip-swatches">
        <div className="strip-swatch" style={{ backgroundColor: family.dim }} title="dim" />
        <div className="strip-swatch strip-swatch-base" style={{ backgroundColor: family.base }} title="base" />
        <div className="strip-swatch" style={{ backgroundColor: family.bright }} title="bright" />
        <div className="strip-swatch strip-swatch-glow" style={{ background: family.glow, border: `1px solid ${family.base}` }} title="glow" />
      </div>
    </div>
  );
}

/** Horizontal ramp of colors with labels below */
function ColorRamp({ items, bgColor }: { items: { label: string; color: string }[]; bgColor?: string }) {
  return (
    <div className="color-ramp">
      {items.map((item) => (
        <div key={item.label} className="ramp-item">
          <div
            className="ramp-swatch"
            style={{ backgroundColor: item.color, ...(bgColor ? { border: `1px solid ${bgColor}` } : {}) }}
          />
          <span className="ramp-label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Semantic role → accent mapping display */
function SemanticMap({ items }: { items: DerivedTokens['semantic'] }) {
  return (
    <div className="semantic-map">
      {items.map((item) => (
        <div key={item.label} className="semantic-item">
          <div className="semantic-swatch" style={{ backgroundColor: item.color }} />
          <span className="semantic-label">{item.label}</span>
          <span className="semantic-accent">{item.accent}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Chat preview ────────────────────────────────────────────────────────────

function ChatPreview({ palette, derived }: { palette: Palette16; derived: DerivedTokens }) {
  return (
    <div
      className="chat-preview"
      style={{ backgroundColor: palette.base03, borderColor: palette.base02 }}
    >
      <div className="preview-header" style={{ borderColor: palette.base02 }}>
        <span style={{ color: palette.base0 }}>Chat Preview</span>
        <span className="preview-badge" style={{ backgroundColor: palette.violet, color: palette.base03 }}>
          claude
        </span>
      </div>
      <div className="preview-messages">
        <div className="preview-message user">
          <span className="preview-role" style={{ color: palette.blue }}>user</span>
          <div
            className="preview-content"
            style={{
              background: `linear-gradient(135deg, ${derived.messages[0].color} 0%, ${mixTransparentSrgb(palette.blue, 8)} 100%)`,
              color: palette.base0,
              borderLeft: `3px solid ${palette.blue}`,
            }}
          >
            How do I implement a binary search?
          </div>
        </div>
        <div className="preview-message assistant">
          <span className="preview-role" style={{ color: palette.cyan }}>assistant</span>
          <div
            className="preview-content"
            style={{
              background: `linear-gradient(135deg, ${derived.messages[1].color} 0%, ${mixTransparentSrgb(palette.cyan, 8)} 100%)`,
              color: palette.base0,
              borderLeft: `3px solid ${palette.cyan}`,
            }}
          >
            Here's a binary search implementation:
            <pre style={{ backgroundColor: palette.base03, borderColor: palette.base02, color: palette.base01 }}>
              {`function binarySearch(arr, target) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] === target) return mid;
    arr[mid] < target ? lo = mid + 1 : hi = mid - 1;
  }
  return -1;
}`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main picker ─────────────────────────────────────────────────────────────

export function ColorPalettePicker({ onClose }: Props) {
  const settings = useSettingsStore((s) => s.settings);
  const customPalettes = useSettingsStore((s) => s.customPalettes);
  const allPalettes = { ...PALETTES, ...customPalettes };
  const setColorPalette = useSettingsStore((s) => s.setColorPalette);
  const previewPalette = useSettingsStore((s) => s.previewPalette);
  const restorePalette = useSettingsStore((s) => s.restorePalette);
  const addCustomPalette = useSettingsStore((s) => s.addCustomPalette);

  const [selectedPalette, setSelectedPalette] = useState(settings.colorPalette);
  const [aiMode, setAiMode] = useState(false);
  const [aiDescription, setAiDescription] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const aiInputRef = useRef<HTMLTextAreaElement>(null);

  const currentPalette = allPalettes[selectedPalette] ?? PALETTES.solarized;
  const derived = derivePalette(currentPalette);

  const handleSelect = (key: string) => {
    setSelectedPalette(key);
    previewPalette(key);
    setAiMode(false);
  };

  const handleSave = () => {
    setColorPalette(selectedPalette);
    onClose();
  };

  const handleCancel = () => {
    restorePalette();
    onClose();
  };

  const handleAiGenerate = async () => {
    if (!aiDescription.trim() || isGenerating) return;

    setIsGenerating(true);
    setAiError(null);

    try {
      const res = await fetch('/api/generate-palette', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: aiDescription.trim() }),
      });

      if (!res.ok) {
        const data = await res.json() as { error: string };
        throw new Error(data.error);
      }

      const { key, palette } = await res.json() as { key: string; palette: Palette16 };
      addCustomPalette(key, palette);
      setSelectedPalette(key);
      // Apply directly — previewPalette would read stale customPalettes closure
      applyPalette(palette);
      setAiMode(false);
      setAiDescription('');
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Failed to generate palette');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="palette-picker-overlay" onClick={handleCancel}>
      <div className="palette-picker" onClick={(e) => e.stopPropagation()}>
        <div className="palette-picker-header">
          <h2>Color Palette</h2>
          <button type="button" className="close-btn" onClick={handleCancel}>&times;</button>
        </div>

        <div className="palette-picker-content">
          {/* ─── Left: palette list ─── */}
          <div className="palette-list">
            {Object.entries(allPalettes).map(([key, palette]) => (
              <button
                key={key}
                type="button"
                className={`palette-option ${selectedPalette === key ? 'selected' : ''}`}
                onClick={() => handleSelect(key)}
              >
                <div className="palette-swatches">
                  {ACCENT_KEYS.map((ak) => (
                    <div key={ak} className="mini-swatch" style={{ backgroundColor: palette[ak] }} />
                  ))}
                </div>
                <span className="palette-name">{palette.name}</span>
              </button>
            ))}

            <div className="palette-list-divider" />

            <button
              type="button"
              className={`ai-generate-btn ${aiMode ? 'active' : ''}`}
              onClick={() => setAiMode(!aiMode)}
            >
              <span className="ai-sparkle">&#10022;</span>
              AI Generate
            </button>
          </div>

          {/* ─── Right: preview + token visualization ─── */}
          <div className="palette-preview-section">
            {aiMode ? (
              <div className="ai-input-section">
                <div className="ai-chat-row">
                  <textarea
                    ref={aiInputRef}
                    className="ai-chat-input"
                    placeholder="Describe your color palette..."
                    value={aiDescription}
                    onChange={(e) => setAiDescription(e.target.value)}
                    disabled={isGenerating}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleAiGenerate();
                      }
                    }}
                    rows={3}
                  />
                  <button
                    type="button"
                    className="ai-submit-btn"
                    onClick={handleAiGenerate}
                    disabled={isGenerating || !aiDescription.trim()}
                  >
                    {isGenerating ? (
                      <span className="ai-generating">Generating<span className="ai-dots" /></span>
                    ) : (
                      'Generate'
                    )}
                  </button>
                </div>
                {aiError && <div className="ai-error">{aiError}</div>}
              </div>
            ) : (
              <div className="preview-scroll">
                <ChatPreview palette={currentPalette} derived={derived} />

                {/* Accent families: dim → base → bright → glow strips */}
                <div className="section-group">
                  <h3 className="section-title">Accent Families</h3>
                  <p className="section-subtitle">dim &middot; base &middot; bright &middot; glow</p>
                  <div className="accent-strips">
                    {ACCENT_KEYS.map((key) => (
                      <AccentStrip key={key} name={key} family={derived.accents[key]} />
                    ))}
                  </div>
                </div>

                {/* Background elevation */}
                <div className="section-group">
                  <h3 className="section-title">Background Elevation</h3>
                  <ColorRamp items={derived.bg} />
                </div>

                {/* Text scale */}
                <div className="section-group">
                  <h3 className="section-title">Text Scale</h3>
                  <ColorRamp items={derived.text} bgColor={currentPalette.base03} />
                </div>

                {/* Borders */}
                <div className="section-group">
                  <h3 className="section-title">Border Scale</h3>
                  <ColorRamp items={derived.borders} bgColor={currentPalette.base03} />
                </div>

                {/* Semantic roles */}
                <div className="section-group">
                  <h3 className="section-title">Semantic Roles</h3>
                  <SemanticMap items={derived.semantic} />
                </div>

                {/* Message tints */}
                <div className="section-group">
                  <h3 className="section-title">Message Tints</h3>
                  <ColorRamp items={derived.messages} />
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="palette-picker-footer">
          <button type="button" className="cancel-btn" onClick={handleCancel}>Cancel</button>
          <button type="button" className="save-btn" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
