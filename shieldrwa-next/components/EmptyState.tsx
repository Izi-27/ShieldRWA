"use client";

import { BODY, CREAM, FONT_BLACK, FONT_MONO, GOLD, MAUVE } from "@/lib/theme";
import { HoverButton } from "./Hover";

export default function EmptyState({
  title,
  body,
  ctaLabel,
  onCta,
  busy = false,
}: {
  title: string;
  body: string;
  ctaLabel: string;
  onCta: () => void;
  busy?: boolean;
}) {
  return (
    <main style={{ padding: "96px 34px 120px", maxWidth: 720 }}>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 11,
          letterSpacing: "0.2em",
          color: GOLD,
        }}
      >
        PROTECTION LOOP · IDLE
      </div>
      <h2
        style={{
          fontFamily: FONT_BLACK,
          fontSize: "clamp(30px,4.4vw,52px)",
          lineHeight: 1,
          margin: "18px 0 0",
        }}
      >
        {title}
      </h2>
      <div
        style={{
          height: 2,
          width: 44,
          background: MAUVE,
          margin: "22px 0",
        }}
      />
      <p
        style={{
          fontSize: 15,
          lineHeight: 1.55,
          color: BODY,
          maxWidth: "52ch",
          margin: 0,
        }}
      >
        {body}
      </p>
      <HoverButton
        onClick={onCta}
        disabled={busy}
        hoverStyle={{ color: GOLD, borderColor: GOLD, gap: 26 }}
        style={{
          appearance: "none",
          background: "none",
          border: 0,
          borderBottom: `3px solid ${MAUVE}`,
          color: busy ? BODY : CREAM,
          fontFamily: FONT_BLACK,
          fontSize: 22,
          padding: "0 0 11px",
          cursor: busy ? "wait" : "pointer",
          marginTop: 40,
          display: "flex",
          alignItems: "center",
          gap: 18,
          transition: "color .18s,border-color .18s,gap .18s",
        }}
      >
        {busy ? "WORKING…" : ctaLabel} <span>→</span>
      </HoverButton>
    </main>
  );
}
