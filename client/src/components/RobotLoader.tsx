import { useEffect, useRef, useState } from 'react';
import './RobotLoader.css';

/**
 * Robot dot-gradient loader — a robot head silhouette made of dots
 * with a rotating color sweep animation.
 */
export function RobotLoader() {
  const dotGridRef = useRef<SVGGElement>(null);
  const [density, setDensity] = useState<'normal' | 'dense'>('normal');
  const [fast, setFast] = useState(false);
  const [glowOn, setGlowOn] = useState(true);

  useEffect(() => {
    const dotGrid = dotGridRef.current;
    if (!dotGrid) return;

    // Clear existing dots
    while (dotGrid.firstChild) {
      dotGrid.removeChild(dotGrid.firstChild);
    }

    const vb = { w: 180, h: 180 };
    const gap = density === 'dense' ? 5.2 : 6.2;
    const startX = 18;
    const startY = 18;
    const endX = vb.w - 18;
    const endY = vb.h - 18;

    let row = 0;
    for (let y = startY; y <= endY; y += gap) {
      const offset = row % 2 ? gap * 0.5 : 0;
      for (let x = startX; x <= endX; x += gap) {
        const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        u.setAttribute('href', '#dot');
        u.setAttribute('x', (x + offset).toFixed(2));
        u.setAttribute('y', y.toFixed(2));

        const jitter = (Math.random() * 0.16 + 0.92).toFixed(3);
        u.setAttribute(
          'transform',
          `translate(${(x + offset).toFixed(2)} ${y.toFixed(2)}) scale(${jitter}) translate(${(-(x + offset)).toFixed(2)} ${(-y).toFixed(2)})`
        );

        dotGrid.appendChild(u);
      }
      row++;
    }
  }, [density]);

  return (
    <div className="robot-loader-page">
      <div
        className="robot-loader-wrap"
        style={{
          '--spin': fast ? '0.85s' : '1.35s',
          '--glow': glowOn ? '0.55' : '0.0',
        } as React.CSSProperties}
      >
        <svg className="robot-loader-svg" viewBox="0 0 180 180" role="img" aria-label="Robot loader">
          <defs>
            <path
              id="robotHead"
              d="
                M60 48
                C60 35 70 24 83 24
                H97
                C110 24 120 35 120 48
                V58
                C132 62 140 74 140 88
                V112
                C140 132 124 148 104 148
                H76
                C56 148 40 132 40 112
                V88
                C40 74 48 62 60 58
                Z
                M72 48
                H108
                C110 48 112 46 112 44
                C112 39 108 35 103 35
                H77
                C72 35 68 39 68 44
                C68 46 70 48 72 48
                Z
              "
            />

            <mask id="maskRobot">
              <rect x="0" y="0" width="180" height="180" fill="black" />
              <use href="#robotHead" fill="white" />
            </mask>

            <circle id="dot" r="2.35" />

            <g id="dotGrid" ref={dotGridRef} />

            <radialGradient id="ring" cx="50%" cy="50%" r="55%">
              <stop offset="0%" stopColor="rgba(0,0,0,0)" />
              <stop offset="55%" stopColor="rgba(0,0,0,0)" />
              <stop offset="72%" stopColor="rgba(255,255,255,0.12)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0)" />
            </radialGradient>

            <linearGradient id="sweepGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#67e8f9" stopOpacity="0" />
              <stop offset="35%" stopColor="#67e8f9" stopOpacity="0" />
              <stop offset="55%" stopColor="#60a5fa" stopOpacity="0.55" />
              <stop offset="70%" stopColor="#a78bfa" stopOpacity="0.85" />
              <stop offset="82%" stopColor="#fb7185" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#fb7185" stopOpacity="0" />
            </linearGradient>

            <mask id="maskSweep">
              <rect x="0" y="0" width="180" height="180" fill="black" />
              <g className="robot-sweep">
                <rect x="18" y="78" width="144" height="24" fill="white" rx="12" ry="12" />
              </g>
            </mask>

            <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="1.6" result="b" />
              <feColorMatrix
                in="b"
                type="matrix"
                values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8"
                result="g"
              />
              <feMerge>
                <feMergeNode in="g" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <g className="robot-breathe">
            <g className="robot-dots" mask="url(#maskRobot)">
              <use href="#dotGrid" />
            </g>

            <g className="robot-dotsColor" mask="url(#maskRobot)">
              <g mask="url(#maskSweep)">
                <rect x="0" y="0" width="180" height="180" fill="url(#sweepGrad)" />
                <g className="robot-sweep">
                  <circle cx="90" cy="90" r="62" fill="url(#ring)" />
                </g>
              </g>

              <mask id="maskDots">
                <rect x="0" y="0" width="180" height="180" fill="black" />
                <g>
                  <use href="#dotGrid" fill="white" />
                </g>
              </mask>

              <g mask="url(#maskDots)">
                <g mask="url(#maskSweep)">
                  <rect x="0" y="0" width="180" height="180" fill="url(#sweepGrad)" />
                  <g className="robot-sweep">
                    <circle cx="90" cy="90" r="62" fill="url(#ring)" />
                  </g>
                </g>
              </g>
            </g>

            <use
              href="#robotHead"
              fill="none"
              stroke="rgba(255,255,255,0.12)"
              strokeWidth="2"
              filter="url(#softGlow)"
            />
          </g>
        </svg>

        <div className="robot-loader-label">Loading...</div>

        <div className="robot-loader-controls">
          <button onClick={() => setFast((f) => !f)}>
            Toggle speed
          </button>
          <button onClick={() => setGlowOn((g) => !g)}>
            Toggle glow
          </button>
          <button onClick={() => setDensity((d) => (d === 'dense' ? 'normal' : 'dense'))}>
            Toggle dot density
          </button>
        </div>
      </div>
    </div>
  );
}
