/**
 * Shown for the few hundred milliseconds it takes to open the database and the
 * audio device — and, if something goes badly wrong, instead of a blank window.
 *
 * It deliberately uses inline styles and no imports from `@ritmo/ui`: if the
 * design system itself failed to load, this still has to render something
 * readable.
 */

// English only: this screen renders before settings are read, so the chosen
// language is not known yet.
const STEPS: Record<string, string> = {
  host: 'Starting up…',
  settings: 'Reading your settings…',
  library: 'Opening the library…',
  providers: 'Connecting to sources…',
  player: 'Preparing the audio engine…',
};

export function BootScreen({ step, error }: { step: string; error?: unknown }) {
  const failed = step === 'error';
  const message = failed
    ? error instanceof Error
      ? error.message
      : String(error)
    : (STEPS[step] ?? 'Starting up…');

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 20,
        background: 'rgb(11 15 20)',
        color: 'rgb(234 241 247)',
        fontFamily: 'InterVariable, Inter, system-ui, sans-serif',
        WebkitUserSelect: 'none',
        userSelect: 'none',
      }}
    >
      <svg width="72" height="72" viewBox="0 0 512 512" aria-hidden="true">
        <defs>
          <linearGradient id="bootg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#4FC3F7" />
            <stop offset="100%" stopColor="#1793D1" />
          </linearGradient>
        </defs>
        <rect width="512" height="512" rx="116" fill="url(#bootg)" />
        <g fill="#ffffff">
          {[
            [112, 208, 96],
            [178, 152, 208],
            [244, 110, 292],
            [310, 152, 208],
            [376, 208, 96],
          ].map(([x, y, h], i) => (
            <rect key={i} x={x} y={y} width="42" height={h} rx="21">
              {!failed && (
                <animate
                  attributeName="opacity"
                  values="1;0.35;1"
                  dur="1.3s"
                  begin={`${i * 0.13}s`}
                  repeatCount="indefinite"
                />
              )}
            </rect>
          ))}
        </g>
      </svg>

      <div style={{ fontSize: 22, fontWeight: 650, letterSpacing: '-0.01em' }}>Ritmo</div>

      <div
        role="status"
        aria-live="polite"
        style={{
          fontSize: 13,
          color: failed ? 'rgb(239 83 80)' : 'rgb(154 170 187)',
          maxWidth: 420,
          textAlign: 'center',
          lineHeight: 1.5,
        }}
      >
        {message}
      </div>

      {failed && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: 4,
            padding: '8px 18px',
            borderRadius: 999,
            border: 'none',
            background: 'rgb(23 147 209)',
            color: 'rgb(3 26 38)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      )}
    </div>
  );
}
