/**
 * The Mocha Glass scene behind the whole app: the canvas, four slow-drifting
 * blobs and the film grain, as the design system's scenes() draws them.
 * Fixed and behind everything; the pause button (html.mg-paused) and
 * prefers-reduced-motion stop the drift (bundle.css).
 */
export default function SceneBackdrop() {
  return (
    <div className="mg-scene mg-backdrop" aria-hidden="true">
      <div className="mg-blobs">
        <i className="mg-blob" />
        <i className="mg-blob" />
        <i className="mg-blob" />
        <i className="mg-blob" />
        <svg className="mg-grain" width="100%" height="100%" aria-hidden="true">
          <filter id="mgGrain">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter="url(#mgGrain)" />
        </svg>
      </div>
    </div>
  );
}
