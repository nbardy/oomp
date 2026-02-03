/**
 * FilePreview — inline file path preview for images & HTML in chat messages.
 *
 * Detects absolute file paths (in inline code) ending in image/HTML extensions
 * and renders them as: icon + clickable link + CSS-only hover popup preview.
 *
 * Wired into react-markdown via the `code` component override in Chat.tsx.
 */

import './FilePreview.css';

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|svg|webp)$/i;
const HTML_EXTENSIONS = /\.(html|htm)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|webm)$/i;

/**
 * Returns 'image' | 'html' | 'video' | null for a given text string.
 * Only matches absolute paths (starts with `/`, no spaces).
 */
export function getPreviewType(text: string): 'image' | 'html' | 'video' | null {
  if (!text.startsWith('/') || text.includes(' ')) return null;
  if (IMAGE_EXTENSIONS.test(text)) return 'image';
  if (VIDEO_EXTENSIONS.test(text)) return 'video';
  if (HTML_EXTENSIONS.test(text)) return 'html';
  return null;
}

interface FilePreviewProps {
  path: string;
  type: 'image' | 'html' | 'video';
}

const TYPE_ICONS = { image: '🖼', html: '🌐', video: '🎬' } as const;

export function FilePreview({ path, type }: FilePreviewProps) {
  const fileUrl = `/api/files?path=${encodeURIComponent(path)}`;

  return (
    <span className="file-preview">
      <span className="file-preview-icon">{TYPE_ICONS[type]}</span>
      <a className="file-preview-link" href={fileUrl} target="_blank" rel="noreferrer">
        {path}
      </a>
      <span className="file-preview-popup">
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
      </span>
    </span>
  );
}
