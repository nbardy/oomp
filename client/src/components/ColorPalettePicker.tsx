import { useState } from 'react';
import { useSettings, PALETTES, applyPalette, type Palette16 } from '../hooks/useSettings';
import './ColorPalettePicker.css';

interface Props {
  onClose: () => void;
}

// Color brick with label
function ColorBrick({ color, label }: { color: string; label: string }) {
  return (
    <div className="color-brick">
      <div className="color-swatch" style={{ backgroundColor: color }} />
      <span className="color-label">{label}</span>
      <span className="color-hex">{color}</span>
    </div>
  );
}

// Accent color keys shown as swatches in the palette list and detail grid
const ACCENT_KEYS = ['blue', 'cyan', 'violet', 'green', 'yellow', 'orange', 'red', 'magenta'] as const;

// Example chat preview using Palette16 flat keys
function ChatPreview({ palette }: { palette: Palette16 }) {
  return (
    <div
      className="chat-preview"
      style={{
        backgroundColor: palette.base03,
        borderColor: palette.base02,
      }}
    >
      <div className="preview-header" style={{ borderColor: palette.base02 }}>
        <span style={{ color: palette.base0 }}>Chat Preview</span>
        <span className="preview-badge" style={{ backgroundColor: palette.violet, color: palette.base03 }}>
          claude
        </span>
      </div>
      <div className="preview-messages">
        <div className="preview-message user">
          <span className="preview-role" style={{ color: palette.blue }}>
            user
          </span>
          <div className="preview-content" style={{ backgroundColor: palette.base02, color: palette.base0 }}>
            How do I implement a binary search?
          </div>
        </div>
        <div className="preview-message assistant">
          <span className="preview-role" style={{ color: palette.cyan }}>
            assistant
          </span>
          <div className="preview-content" style={{ backgroundColor: palette.base02, color: palette.base0 }}>
            Here's a binary search implementation:
            <pre
              style={{
                backgroundColor: palette.base03,
                borderColor: palette.base02,
                color: palette.base01,
              }}
            >
              {`function binarySearch(arr, target) {
  let left = 0, right = arr.length - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) left = mid + 1;
    else right = mid - 1;
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

export function ColorPalettePicker({ onClose }: Props) {
  const { settings, setColorPalette, previewPalette, restorePalette, addCustomPalette, allPalettes } = useSettings();
  const [selectedPalette, setSelectedPalette] = useState(settings.colorPalette);
  const [aiMode, setAiMode] = useState(false);
  const [aiDescription, setAiDescription] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const currentPalette = allPalettes[selectedPalette] || PALETTES.solarized;

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
      // Apply directly -- previewPalette would read stale customPalettes closure
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
          <button type="button" className="close-btn" onClick={handleCancel}>
            &times;
          </button>
        </div>

        <div className="palette-picker-content">
          <div className="palette-list">
            {Object.entries(allPalettes).map(([key, palette]) => (
              <button
                key={key}
                type="button"
                className={`palette-option ${selectedPalette === key ? 'selected' : ''}`}
                onClick={() => handleSelect(key)}
              >
                <div className="palette-swatches">
                  <div className="mini-swatch" style={{ backgroundColor: palette.base03 }} />
                  <div className="mini-swatch" style={{ backgroundColor: palette.blue }} />
                  <div className="mini-swatch" style={{ backgroundColor: palette.cyan }} />
                  <div className="mini-swatch" style={{ backgroundColor: palette.violet }} />
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

          <div className="palette-preview-section">
            {aiMode ? (
              <div className="ai-input-section">
                <div className="ai-chat-row">
                  <textarea
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
              <>
                <ChatPreview palette={currentPalette} />

                <div className="color-grid">
                  <ColorBrick color={currentPalette.base03} label="Base03 (bg)" />
                  <ColorBrick color={currentPalette.base02} label="Base02 (surface)" />
                  <ColorBrick color={currentPalette.base01} label="Base01 (muted)" />
                  <ColorBrick color={currentPalette.base00} label="Base00 (secondary)" />
                  <ColorBrick color={currentPalette.base0} label="Base0 (text)" />
                  <ColorBrick color={currentPalette.base1} label="Base1 (emphasis)" />
                  {ACCENT_KEYS.map((key) => (
                    <ColorBrick key={key} color={currentPalette[key]} label={key.charAt(0).toUpperCase() + key.slice(1)} />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="palette-picker-footer">
          <button type="button" className="cancel-btn" onClick={handleCancel}>
            Cancel
          </button>
          <button type="button" className="save-btn" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
