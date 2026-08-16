"use client";

import { CREAM, FONT_BLACK, FONT_MONO, GOLD, MUTE } from "@/lib/theme";
import type { LiveShieldVM } from "@/lib/useLiveShield";
import { HoverButton } from "./Hover";

export default function DecisionModal({ vm }: { vm: LiveShieldVM }) {
  const modal = vm.modal;
  if (!modal) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Protective action proposed"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(10,8,9,0.86)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "min(820px,100%)",
          background: "#1B1517",
          padding: "34px 38px 0",
          animation: "shRise .2s ease-out",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 20,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: "0.18em",
              color: GOLD,
            }}
          >
            PROTECTIVE ACTION PROPOSED
          </div>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: "0.14em",
              color: MUTE,
            }}
          >
            POLICY: {vm.policyLabel}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 18,
            flexWrap: "wrap",
            marginTop: 20,
          }}
        >
          <div style={{ fontFamily: FONT_BLACK, fontSize: 52, color: GOLD }}>
            {modal.action}
          </div>
          <div style={{ fontFamily: FONT_BLACK, fontSize: 32 }}>
            {modal.headline}
          </div>
        </div>
        <div
          style={{
            fontSize: 15,
            lineHeight: 1.55,
            marginTop: 18,
            maxWidth: "68ch",
            textWrap: "pretty",
            color: "#E4DAD3",
          }}
        >
          {modal.body}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
            gap: 32,
            marginTop: 30,
            paddingTop: 22,
            borderTop: "1px solid #2A2325",
          }}
        >
          {modal.stats.map((s) => (
            <div key={s.k}>
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 9.5,
                  letterSpacing: "0.14em",
                  color: MUTE,
                }}
              >
                {s.k}
              </div>
              <div
                style={{
                  fontFamily: FONT_BLACK,
                  fontSize: 23,
                  marginTop: 8,
                  color: s.c,
                }}
              >
                {s.v}
              </div>
            </div>
          ))}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 44,
            marginTop: 38,
            paddingBottom: 34,
          }}
        >
          <HoverButton
            onClick={vm.rejectAction}
            hoverStyle={{ color: CREAM }}
            style={{
              appearance: "none",
              border: 0,
              background: "none",
              color: MUTE,
              fontFamily: FONT_MONO,
              fontSize: 12,
              letterSpacing: "0.16em",
              cursor: "pointer",
              padding: "0 0 9px",
              transition: "color .16s",
            }}
          >
            REJECT · HOLD POSITION
          </HoverButton>
          <HoverButton
            onClick={vm.approveAction}
            hoverStyle={{ color: GOLD, borderColor: GOLD, gap: 22 }}
            style={{
              appearance: "none",
              border: 0,
              borderBottom: "2px solid #7F5461",
              background: "none",
              color: CREAM,
              fontFamily: FONT_MONO,
              fontSize: 12,
              letterSpacing: "0.16em",
              cursor: "pointer",
              fontWeight: 600,
              padding: "0 0 9px",
              display: "flex",
              alignItems: "center",
              gap: 14,
              transition: "color .18s,border-color .18s,gap .18s",
            }}
          >
            APPROVE · EXECUTE ON X LAYER<span>→</span>
          </HoverButton>
        </div>
      </div>
    </div>
  );
}
