/* Minimal backdrop — demo aesthetic is just a solid #000 with a single,
   very faint radial vignette at the centre to give the card depth. No
   floating nicks (we dropped them when we moved to the demo design). */

export function Background() {
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
        background:
          'radial-gradient(ellipse at center, rgba(59, 130, 246, 0.06) 0%, transparent 50%), ' +
          'radial-gradient(ellipse at 80% 20%, rgba(34, 197, 94, 0.03) 0%, transparent 40%), ' +
          'radial-gradient(ellipse at 20% 80%, rgba(239, 68, 68, 0.03) 0%, transparent 40%)',
      }}
    />
  );
}
