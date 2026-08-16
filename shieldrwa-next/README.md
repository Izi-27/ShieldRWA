# ShieldRWA — Next.js

Next.js (App Router, TypeScript) port of `ShieldRWA.dc.html`. Styles, palette, type
scale, animations and imagery are carried over unchanged.

## Run

```bash
npm install
npm run dev      # http://localhost:3000
npm run build && npm start
```

## Structure

| Path | Purpose |
| --- | --- |
| `app/layout.tsx` | Google Fonts (Archivo / Archivo Black / IBM Plex Mono), metadata |
| `app/globals.css` | Resets, scrollbar/selection colors, the five `sh*` keyframes |
| `lib/theme.ts` | Palette constants, risk bands, `money()` formatter |
| `lib/config.ts` | Demo knobs: `positionValue`, `demoSpeed`, `startView` |
| `lib/useShield.ts` | All state, the scripted risk-event timeline, and every derived view value |
| `components/*.tsx` | One component per view: Header, Landing, Onboarding, Dashboard, Policy, ProofLog, DecisionModal |
| `public/uploads/` | Hero and onboarding photography |

## Port notes

- The original component class (`DCLogic`) became the `useShield` hook. `state` →
  `useState`, `componentDidMount` intervals → `useEffect`, `renderVals()` → the
  hook's return value, so component markup reads the same names as before
  (`vm.bandColor`, `vm.spine`, `vm.analyst`, …).
- `<sc-if>` / `<sc-for>` became conditional rendering and `.map()`.
- The `style-hover` attribute has no React equivalent; `components/Hover.tsx`
  provides `HoverBox` / `HoverButton`, which merge a `hoverStyle` over the base
  inline style on pointer enter (and on focus, for keyboard users).
- Component props from the design file (`positionValue`, `demoSpeed`,
  `startView`) are now `DEMO_CONFIG` in `lib/config.ts`.
- All inline styles were kept inline as React `CSSProperties` rather than
  converted to CSS modules, so values stay one-to-one with the source.
