"use client";

import {
  BODY,
  CREAM,
  FONT_BLACK,
  FONT_MONO,
  FONT_SANS,
  GOLD,
  MUTE,
} from "@/lib/theme";
import type { LiveShieldVM } from "@/lib/useLiveShield";
import { HoverButton } from "./Hover";

export default function Policy({ vm }: { vm: LiveShieldVM }) {
  return (
    <main style={{ padding: "44px 34px 72px" }}>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 11,
          letterSpacing: "0.2em",
          color: GOLD,
        }}
      >
        3.5 / PROTECTION POLICY
      </div>
      <h2
        style={{
          fontFamily: FONT_BLACK,
          fontSize: "clamp(30px,4.4vw,58px)",
          lineHeight: 1,
          margin: "16px 0 0",
        }}
      >
        CHOOSE YOUR
        <br />
        PROTECTION POSTURE.
      </h2>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))",
          gap: 48,
          marginTop: 48,
        }}
      >
        {vm.postures.map((p) => (
          <HoverButton
            key={p.title}
            onClick={p.pick}
            hoverStyle={{ color: GOLD }}
            style={{
              textAlign: "left",
              appearance: "none",
              border: 0,
              background: "none",
              padding: 0,
              cursor: "pointer",
              fontFamily: FONT_SANS,
              color: p.fg,
              display: "flex",
              flexDirection: "column",
              transition: "color .2s",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: "0.16em",
                color: MUTE,
              }}
            >
              <span>{p.n}</span>
              <span style={{ color: GOLD }}>{p.mark}</span>
            </div>
            <div style={{ fontFamily: FONT_BLACK, fontSize: 34, marginTop: 16 }}>
              {p.title}
            </div>
            <div
              style={{
                height: 2,
                width: "100%",
                background: p.rule,
                margin: "14px 0",
                transition: "background .2s",
              }}
            />
            <div
              style={{
                fontSize: 14.5,
                lineHeight: 1.5,
                maxWidth: "32ch",
                color: BODY,
              }}
            >
              {p.body}
            </div>
          </HoverButton>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))",
          gap: 44,
          marginTop: 60,
          paddingTop: 34,
          borderTop: "1px solid #2A2325",
        }}
      >
        {vm.policyRows.map((row) => (
          <div key={row.label}>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10.5,
                letterSpacing: "0.16em",
                color: MUTE,
              }}
            >
              {row.label}
            </div>
            <div
              style={{
                fontSize: 13,
                lineHeight: 1.45,
                marginTop: 8,
                color: MUTE,
                minHeight: 38,
              }}
            >
              {row.hint}
            </div>
            <div style={{ display: "flex", gap: 26, marginTop: 12 }}>
              {row.options.map((o) => (
                <HoverButton
                  key={o.label}
                  onClick={o.pick}
                  hoverStyle={{ color: GOLD }}
                  style={{
                    appearance: "none",
                    border: 0,
                    background: "none",
                    padding: "0 0 9px",
                    borderBottom: `2px solid ${o.ul}`,
                    color: o.fg,
                    fontFamily: FONT_MONO,
                    fontSize: 14,
                    letterSpacing: "0.06em",
                    cursor: "pointer",
                    fontWeight: 600,
                    transition: "color .16s,border-color .2s",
                  }}
                >
                  {o.label}
                </HoverButton>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: 28,
          flexWrap: "wrap",
          marginTop: 56,
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 12.5,
            lineHeight: 1.9,
            color: BODY,
            maxWidth: "62ch",
          }}
        >
          {vm.policySentence}
        </div>
        <HoverButton
          onClick={vm.goDash}
          hoverStyle={{ color: GOLD, borderColor: GOLD, gap: 26 }}
          style={{
            appearance: "none",
            background: "none",
            border: 0,
            borderBottom: "3px solid #7F5461",
            color: CREAM,
            fontFamily: FONT_BLACK,
            fontSize: 24,
            padding: "0 0 11px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 18,
            transition: "color .18s,border-color .18s,gap .18s",
          }}
        >
          SAVE POLICY <span>→</span>
        </HoverButton>
      </div>
    </main>
  );
}
