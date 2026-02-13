/**
 * FilePreview — inline file path preview for images, HTML & video in chat messages.
 *
 * Detects file paths (in inline code) ending in previewable extensions and renders
 * them as: icon + clickable link + hover popup preview.
 *
 * Supports both absolute paths (`/data/runs/.../00000.png`) and relative paths
 * (`test_outputs/ssim_debug/render_00000.png`). Relative paths require at least
 * one `/` directory separator to avoid false-matching bare filenames in prose.
 * When a `workingDirectory` prop is provided, relative paths are resolved against
 * it for the API URL while the original relative path is displayed as link text.
 *
 * The popup renders via React Portal to document.body so it escapes parent
 * overflow:hidden / overflow:auto containers (e.g. .messages-container).
 *
 * Wired into react-markdown via the `code` component override in
 * VirtualizedMessageList.tsx.
 */

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './FilePreview.css';

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|svg|webp)$/i;
const HTML_EXTENSIONS = /\.(html|htm)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|webm)$/i;

/**
 * Returns 'image' | 'html' | 'video' | null for a given text string.
 * Matches absolute paths (`/foo/bar.png`) and relative paths with at least one
 * directory separator (`test_outputs/render.png`). Bare filenames like `foo.png`
 * are rejected to avoid false-matching inline code in prose.
 */
export function getPreviewType(text: string): 'image' | 'html' | 'video' | null {
  if (text.includes(' ')) return null;
  // Must contain at least one `/` (absolute or relative with directory)
  if (!text.includes('/')) return null;
  if (IMAGE_EXTENSIONS.test(text)) return 'image';
  if (VIDEO_EXTENSIONS.test(text)) return 'video';
  if (HTML_EXTENSIONS.test(text)) return 'html';
  return null;
}

interface FilePreviewProps {
  path: string;
  type: 'image' | 'html' | 'video';
  /** When set, relative paths are resolved against this directory for the API URL. */
  workingDirectory?: string;
}

const TYPE_ICONS = { image: '🖼', html: '🌐', video: '🎬' } as const;

/** Gap in px between the trigger element and the popup */
const POPUP_GAP = 8;

/** Minimum margin from viewport edges */
const VIEWPORT_MARGIN = 12;

interface PopupPosition {
  top: number;
  left: number;
  placement: 'above' | 'below';
}

export function FilePreview({ path, type, workingDirectory }: FilePreviewProps) {
  // Resolve relative paths against workingDirectory for the API URL.
  // Display text stays as the original `path` the user wrote.
  const resolvedPath = path.startsWith('/') ? path : `${workingDirectory}/${path}`;
  const fileUrl = `/api/files?path=${encodeURIComponent(resolvedPath)}`;
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [position, setPosition] = useState<PopupPosition | null>(null);

  const handleMouseEnter = () => {
    const rect = triggerRef.current!.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;

    // Default: place above the trigger. If too close to top, place below.
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    const placement = spaceAbove > spaceBelow ? 'above' : 'below';

    setPosition({
      top: placement === 'above' ? rect.top - POPUP_GAP : rect.bottom + POPUP_GAP,
      left: Math.max(VIEWPORT_MARGIN, Math.min(centerX, window.innerWidth - VIEWPORT_MARGIN)),
      placement,
    });
    setHovered(true);
  };

  const handleMouseLeave = () => {
    setHovered(false);
  };

  const popup = hovered && position && createPortal(
    <div
      className="file-preview-popup"
      style={{
        // 'above': popup bottom edge aligns to `position.top` (above trigger)
        // 'below': popup top edge aligns to `position.top` (below trigger)
        ...(position.placement === 'above'
          ? { bottom: `${window.innerHeight - position.top}px` }
          : { top: `${position.top}px` }
        ),
        left: `${position.left}px`,
      }}
    >
      {type === 'image' && (
        <img className="file-preview-image" src={fileUrl} alt={path} />
      )}
      {type === 'video' && (
        <video className="file-preview-video" src={fileUrl} autoPlay loop muted playsInline />
      )}
      {type === 'html' && (
        <iframe className="file-preview-iframe" src={fileUrl} sandbox="" title={path} />
      )}
      <span className="file-preview-path">{path}</span>
    </div>,
    document.body
  );

  return (
    <span
      className="file-preview"
      ref={triggerRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <span className="file-preview-icon">{TYPE_ICONS[type]}</span>
      <a className="file-preview-link" href={fileUrl} target="_blank" rel="noreferrer">
        {path}
      </a>
      {popup}
    </span>
  );
}
