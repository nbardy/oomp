import { useState } from 'react';
import { useSettings, PALETTES, type ColorPalette } from '../hooks/useSettings';
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

// Example chat preview
function ChatPreview({ palette }: { palette: ColorPalette }) {
  const { colors } = palette;

  return (
    <div
      className="chat-preview"
      style={{
        backgroundColor: colors.background,
        borderColor: colors.border,
      }}
    >
      <div className="preview-header" style={{ borderColor: colors.border }}>
        <span style={{ color: colors.text }}>Chat Preview</span>
        <span className="preview-badge" style={{ backgroundColor: colors.primary, color: colors.background }}>
          claude
        </span>
      </div>
      <div className="preview-messages">
        <div className="preview-message user">
          <span className="preview-role" style={{ color: colors.user }}>
            user
          </span>
          <div className="preview-content" style={{ backgroundColor: colors.surface, color: colors.text }}>
            How do I implement a binary search?
          </div>
        </div>
        <div className="preview-message assistant">
          <span className="preview-role" style={{ color: colors.assistant }}>
            assistant
          </span>
          <div className="preview-content" style={{ backgroundColor: colors.surface, color: colors.text }}>
            Here's a binary search implementation:
            <pre
              style={{
                backgroundColor: colors.background,
                borderColor: colors.border,
                color: colors.textMuted,
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
  const { settings, setColorPalette, previewPalette, restorePalette } = useSettings();
  const [selectedPalette, setSelectedPalette] = useState(settings.colorPalette);

  const currentPalette = PALETTES[selectedPalette] || PALETTES.solarized;

  const handleSelect = (key: string) => {
    setSelectedPalette(key);
    previewPalette(key);
  };

  const handleSave = () => {
    setColorPalette(selectedPalette);
    onClose();
  };

  const handleCancel = () => {
    restorePalette();
    onClose();
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
            {Object.entries(PALETTES).map(([key, palette]) => (
              <button
                key={key}
                type="button"
                className={`palette-option ${selectedPalette === key ? 'selected' : ''}`}
                onClick={() => handleSelect(key)}
              >
                <div className="palette-swatches">
                  <div className="mini-swatch" style={{ backgroundColor: palette.colors.background }} />
                  <div className="mini-swatch" style={{ backgroundColor: palette.colors.primary }} />
                  <div className="mini-swatch" style={{ backgroundColor: palette.colors.secondary }} />
                  <div className="mini-swatch" style={{ backgroundColor: palette.colors.accent }} />
                </div>
                <span className="palette-name">{palette.name}</span>
              </button>
            ))}
          </div>

          <div className="palette-preview-section">
            <ChatPreview palette={currentPalette} />

            <div className="color-grid">
              <ColorBrick color={currentPalette.colors.primary} label="Primary" />
              <ColorBrick color={currentPalette.colors.secondary} label="Secondary" />
              <ColorBrick color={currentPalette.colors.accent} label="Accent" />
              <ColorBrick color={currentPalette.colors.background} label="Background" />
              <ColorBrick color={currentPalette.colors.surface} label="Surface" />
              <ColorBrick color={currentPalette.colors.text} label="Text" />
              <ColorBrick color={currentPalette.colors.textMuted} label="Text Muted" />
              <ColorBrick color={currentPalette.colors.border} label="Border" />
              <ColorBrick color={currentPalette.colors.user} label="User" />
              <ColorBrick color={currentPalette.colors.assistant} label="Assistant" />
            </div>
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
