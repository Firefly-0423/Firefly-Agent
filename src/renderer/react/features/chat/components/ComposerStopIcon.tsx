import React from "react";

/**
 * The composer's stop button icon: the same square-in-a-ring as @ant-design/x's StopLoading, but the arc turns with a
 * CSS transform instead of an SVG <animateTransform>. SMIL runs on the main thread and invalidated the whole window on
 * every frame of a run (about 70% of the renderer's time in a long conversation, measured 2026-11-08); a CSS
 * transform runs on the compositor.
 */
export function ComposerStopIcon({ title }: { title: string }) {
  return (
    <svg className="ff-composer__stop-icon" viewBox="0 0 1000 1000" xmlns="http://www.w3.org/2000/svg" color="currentColor" role="img" aria-label={title}>
      <rect fill="currentColor" height="250" rx="24" ry="24" width="250" x="375" y="375" />
      <circle cx="500" cy="500" fill="none" r="450" stroke="currentColor" strokeWidth="100" opacity="0.45" />
      <g className="ff-composer__stop-arc">
        <circle cx="500" cy="500" fill="none" r="450" stroke="currentColor" strokeWidth="100" strokeDasharray="600 9999999" />
      </g>
    </svg>
  );
}
