import type { CSSProperties } from 'react';

/**
 * Placeholder for M7 (carte & simulation) in this standalone harness. It only
 * sketches the layout so the hand-off can be judged; it shows no data.
 */
const shell: CSSProperties = {
  minHeight: '100vh',
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 320px) 1fr',
  background: '#0b1210',
  color: '#e9f2ea',
  fontFamily: "'Manrope Variable', system-ui, sans-serif",
};

export function DashboardStandIn() {
  return (
    <main style={shell} className="standin">
      <style>{`
        @media (max-width: 760px) { .standin { grid-template-columns: 1fr !important; grid-template-rows: auto 1fr; } }
        .standin-map { background:
          radial-gradient(60% 60% at 45% 45%, rgba(201,239,134,.08), transparent 70%),
          linear-gradient(rgba(201,239,134,.05) 1px, transparent 1px) 0 0/48px 48px,
          linear-gradient(90deg, rgba(201,239,134,.05) 1px, transparent 1px) 0 0/48px 48px, #0d1714; }
      `}</style>
      <aside style={{ padding: 28, borderRight: '1px solid rgba(201,239,134,.12)', display: 'grid', alignContent: 'start', gap: 18 }}>
        <p style={{ margin: 0, fontFamily: "'Space Grotesk Variable', sans-serif", letterSpacing: '.22em', fontSize: 13 }}>MIZUHO</p>
        <h1 style={{ margin: 0, fontFamily: "'Space Grotesk Variable', sans-serif", fontWeight: 500, fontSize: 28, letterSpacing: '-.02em' }}>
          Irrigation observatory
        </h1>
        <p style={{ margin: 0, color: 'rgba(233,242,234,.6)', lineHeight: 1.5 }}>
          Placeholder for module M7 · Map &amp; simulation (Jendouba). In the real app,
          <code style={{ color: '#c9ef86' }}> &lt;ExperienceGate&gt;</code> wraps M7’s root component.
        </p>
      </aside>
      <section className="standin-map" style={{ display: 'grid', placeItems: 'center', color: 'rgba(233,242,234,.4)', fontSize: 13 }}>
        M7 map area
      </section>
    </main>
  );
}
