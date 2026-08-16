"use client";

import { BODY, FONT_BLACK, FONT_MONO, GOLD, MUTE } from "@/lib/theme";
import type { LiveShieldVM } from "@/lib/useLiveShield";
import { HoverButton } from "./Hover";

export default function Onboarding({ vm }: { vm: LiveShieldVM }) {
  return (
    <>
      <section
        style={{
          position: "relative",
          backgroundColor: "#171314",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "url('/uploads/behnam-norouzi-hScr17JG74Q-unsplash.jpg')",
            backgroundSize: "cover",
            backgroundPosition: "center",
            opacity: 0.3,
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg,rgba(23,19,20,0.74) 0%,rgba(127,84,97,0.34) 100%)",
          }}
        />
        <div
          style={{
            position: "relative",
            padding: "52px 34px 44px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            gap: 28,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: "0.2em",
                color: GOLD,
              }}
            >
              04 / USER EXPERIENCE
            </div>
            <h2
              style={{
                fontFamily: FONT_BLACK,
                fontSize: "clamp(28px,4.4vw,54px)",
                lineHeight: 1,
                margin: "16px 0 0",
              }}
            >
              THREE STEPS TO A
              <br />
              PROTECTED POSITION.
            </h2>
          </div>
          <div
            style={{
              display: "flex",
              gap: 26,
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: "0.14em",
            }}
          >
            {vm.stepChips.map((c) => (
              <span
                key={c.label}
                style={{
                  color: c.fg,
                  borderBottom: `2px solid ${c.ul}`,
                  paddingBottom: 6,
                  transition: "color .2s,border-color .2s",
                }}
              >
                {c.label}
              </span>
            ))}
          </div>
        </div>
      </section>

      <main
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))",
          gap: 52,
          padding: "48px 34px 64px",
        }}
      >
        {vm.onboardSteps.map((st) => (
          <section
            key={st.n}
            style={{ display: "flex", flexDirection: "column", color: st.fg }}
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
              <span>STEP {st.n}</span>
              <span style={{ color: st.statusC }}>{st.status}</span>
            </div>
            <div
              style={{
                fontFamily: FONT_BLACK,
                fontSize: 32,
                lineHeight: 1.02,
                marginTop: 20,
                whiteSpace: "pre-line",
                color: st.titleC,
              }}
            >
              {st.title}
            </div>
            <div
              style={{
                height: 2,
                width: 44,
                background: st.rule,
                margin: "16px 0",
              }}
            />
            <div
              style={{
                fontSize: 14.5,
                lineHeight: 1.5,
                maxWidth: "34ch",
                color: BODY,
              }}
            >
              {st.body}
            </div>
            <div style={{ marginTop: 26 }}>
              {st.rows.map((r) => (
                <div
                  key={r.k}
                  style={{
                    padding: "12px 0",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    borderBottom: "1px solid #2A2325",
                  }}
                >
                  <span style={{ color: MUTE }}>{r.k}</span>
                  <span style={{ fontWeight: 600 }}>{r.v}</span>
                </div>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <HoverButton
              onClick={st.action}
              hoverStyle={{ color: GOLD, borderColor: GOLD, gap: 22 }}
              style={{
                appearance: "none",
                background: "none",
                border: 0,
                borderBottom: `2px solid ${st.rule}`,
                color: st.btnFg,
                fontFamily: FONT_MONO,
                fontSize: 12.5,
                letterSpacing: "0.16em",
                padding: "0 0 12px",
                cursor: "pointer",
                marginTop: 32,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                transition: "color .18s,border-color .18s,gap .18s",
              }}
            >
              {st.cta}
              <span>→</span>
            </HoverButton>
          </section>
        ))}
      </main>
    </>
  );
}
