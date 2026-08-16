"use client";

import {
  BODY,
  CREAM,
  FONT_BLACK,
  FONT_MONO,
  FONT_SANS,
  GOLD,
  MUTE,
  ROSE,
} from "@/lib/theme";
import type { LiveShieldVM } from "@/lib/useLiveShield";
import { HoverBox, HoverButton } from "./Hover";

const MARQUEE_WORDS = ["DETECT", "UNDERSTAND", "DECIDE", "PROTECT"];

function MarqueeRun() {
  return (
    <span style={{ display: "flex", gap: 44 }}>
      {[...MARQUEE_WORDS, ...MARQUEE_WORDS].map((w, i) => (
        <span key={i} style={{ display: "flex", gap: 44 }}>
          {w}
          <span style={{ color: GOLD }}>◆</span>
        </span>
      ))}
    </span>
  );
}

export default function Landing({ vm }: { vm: LiveShieldVM }) {
  return (
    <main>
      <section
        style={{
          position: "relative",
          overflow: "hidden",
          backgroundColor: "#171314",
          backgroundImage:
            "linear-gradient(88deg,rgba(23,19,20,0.96) 0%,rgba(23,19,20,0.84) 44%,rgba(127,84,97,0.48) 100%),url('/uploads/traxer-4PljbcYIzyE-unsplash.jpg')",
          backgroundSize: "cover",
          backgroundPosition: "center 62%",
        }}
      >
        <div
          style={{
            padding: "86px 34px 40px",
            maxWidth: 1180,
            animation: "shRise .5s ease-out",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 30,
            }}
          >
            <div style={{ width: 28, height: 2, background: GOLD }} />
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: "0.2em",
                color: GOLD,
              }}
            >
              AI PREDICTIVE RISK GUARDIAN FOR TOKENIZED REAL-WORLD ASSETS
            </div>
          </div>
          <h1
            style={{
              fontFamily: FONT_BLACK,
              fontSize: "clamp(38px,6.4vw,90px)",
              lineHeight: 0.9,
              letterSpacing: "-0.025em",
              margin: 0,
              textWrap: "balance",
            }}
          >
            MOST RWA PLATFORMS
            <br />
            HELP YOU BUY
            <br />
            THE ASSET.
          </h1>
          <h1
            style={{
              fontFamily: FONT_BLACK,
              fontSize: "clamp(38px,6.4vw,90px)",
              lineHeight: 0.9,
              letterSpacing: "-0.025em",
              margin: "10px 0 0",
              color: ROSE,
            }}
          >
            SHIELDRWA HELPS YOU
            <br />
            SURVIVE OWNING IT.
          </h1>
        </div>

        <div
          style={{
            position: "relative",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-end",
            gap: 56,
            padding: "34px 34px 62px",
          }}
        >
          {vm.ctaDeck.map((c) => (
            <HoverButton
              key={c.title}
              onClick={c.go}
              hoverStyle={{ color: GOLD, gap: 22 }}
              style={{
                appearance: "none",
                border: 0,
                background: "none",
                padding: 0,
                cursor: "pointer",
                textAlign: "left",
                fontFamily: FONT_SANS,
                color: c.fg,
                display: "flex",
                flexDirection: "column",
                gap: 12,
                maxWidth: 300,
                transition: "color .18s,gap .18s",
              }}
            >
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 10.5,
                  letterSpacing: "0.2em",
                  opacity: 0.75,
                }}
              >
                {c.n}
              </span>
              <span
                style={{
                  fontFamily: FONT_BLACK,
                  fontSize: c.size,
                  lineHeight: 1.02,
                  display: "flex",
                  alignItems: "baseline",
                  gap: 12,
                }}
              >
                {c.title}
                <span style={{ fontSize: "0.7em" }}>{c.arrow}</span>
              </span>
              <span style={{ height: 2, background: c.rule, width: "100%" }} />
              <span style={{ fontSize: 13.5, lineHeight: 1.45, opacity: 0.8 }}>
                {c.body}
              </span>
            </HoverButton>
          ))}
        </div>
      </section>

      <div
        style={{
          background: "#7F5461",
          color: CREAM,
          overflow: "hidden",
          padding: "11px 0",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 44,
            whiteSpace: "nowrap",
            animation: "shMarquee 26s linear infinite",
            fontFamily: FONT_BLACK,
            fontSize: 15,
            letterSpacing: "0.06em",
          }}
        >
          <MarqueeRun />
          <MarqueeRun />
        </div>
      </div>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))",
          gap: "40px 56px",
          padding: "44px 34px",
        }}
      >
        {vm.heroStats.map((s) => (
          <div key={s.k}>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.16em",
                color: MUTE,
              }}
            >
              {s.k}
            </div>
            <div
              style={{
                fontFamily: FONT_BLACK,
                fontSize: 38,
                marginTop: 10,
                color: s.c,
              }}
            >
              {s.v}
            </div>
          </div>
        ))}
      </section>

      <section
        style={{
          padding: "52px 34px 60px",
          borderTop: "1px solid #2A2325",
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: "0.18em",
            color: MUTE,
            marginBottom: 34,
          }}
        >
          03.1 / THE FOUR-STEP PROTECTION LOOP
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))",
            gap: "44px 56px",
          }}
        >
          {vm.loopSteps.map((s) => (
            <HoverBox
              key={s.n}
              hoverStyle={{ color: GOLD }}
              style={{ transition: "color .2s" }}
            >
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.18em",
                  color: MUTE,
                }}
              >
                {s.n}
              </div>
              <div
                style={{
                  fontFamily: FONT_BLACK,
                  fontSize: 32,
                  letterSpacing: "-0.01em",
                  marginTop: 14,
                  color: "inherit",
                }}
              >
                {s.title}
              </div>
              <div
                style={{
                  height: 2,
                  background: "#7F5461",
                  width: 44,
                  margin: "14px 0",
                }}
              />
              <div
                style={{
                  fontSize: 14.5,
                  lineHeight: 1.5,
                  maxWidth: "28ch",
                  color: BODY,
                }}
              >
                {s.body}
              </div>
            </HoverBox>
          ))}
        </div>
      </section>

      <section
        style={{ padding: "52px 34px 60px", borderTop: "1px solid #2A2325" }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(240px,320px) 1fr",
            gap: 56,
          }}
        >
          <div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: "0.18em",
                color: GOLD,
              }}
            >
              02 / PROBLEM
            </div>
            <div
              style={{
                fontFamily: FONT_BLACK,
                fontSize: 40,
                lineHeight: 1,
                marginTop: 18,
              }}
            >
              WHAT
              <br />
              HAPPENS
              <br />
              AFTER
              <br />
              YOU BUY.
            </div>
          </div>
          <div>
            {vm.problems.map((p) => (
              <HoverBox
                key={p.k}
                hoverStyle={{ color: CREAM }}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(200px,270px) 1fr",
                  gap: 32,
                  padding: "18px 0",
                  borderBottom: "1px solid #2A2325",
                  color: BODY,
                  transition: "color .15s",
                }}
              >
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    letterSpacing: "0.08em",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    color: ROSE,
                  }}
                >
                  {p.k}
                </div>
                <div style={{ fontSize: 14.5, lineHeight: 1.5 }}>{p.v}</div>
              </HoverBox>
            ))}
          </div>
        </div>
      </section>

      <section
        style={{ padding: "52px 34px 60px", borderTop: "1px solid #2A2325" }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: "0.18em",
            color: MUTE,
            marginBottom: 34,
          }}
        >
          09 / COMPETITIVE DIFFERENTIATION
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(290px,1fr))",
            gap: "36px 56px",
          }}
        >
          {vm.diffs.map((d) => (
            <HoverBox
              key={d.n}
              hoverStyle={{ color: ROSE }}
              style={{
                display: "flex",
                gap: 18,
                alignItems: "flex-start",
                transition: "color .18s",
              }}
            >
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  letterSpacing: "0.12em",
                  color: GOLD,
                  paddingTop: 4,
                }}
              >
                {d.n}
              </div>
              <div
                style={{
                  fontSize: 17,
                  lineHeight: 1.35,
                  fontWeight: 600,
                  textWrap: "pretty",
                }}
              >
                {d.t}
              </div>
            </HoverBox>
          ))}
        </div>
      </section>

      <section
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: 32,
          padding: "64px 34px",
          background: "#7F5461",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            fontFamily: FONT_BLACK,
            fontSize: "clamp(28px,3.8vw,50px)",
            lineHeight: 1.02,
          }}
        >
          READY TO PUT A GUARDIAN
          <br />
          ON YOUR POSITION?
        </div>
        <HoverButton
          onClick={vm.goOnboard}
          hoverStyle={{ color: "#171314", borderColor: "#171314", gap: 26 }}
          style={{
            appearance: "none",
            background: "none",
            border: 0,
            borderBottom: `3px solid ${GOLD}`,
            color: CREAM,
            fontFamily: FONT_BLACK,
            fontSize: 26,
            padding: "0 0 10px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 18,
            transition: "color .18s,border-color .18s,gap .18s",
          }}
        >
          START PROTECTING <span>→</span>
        </HoverButton>
      </section>

      <footer
        style={{
          padding: "56px 34px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          flexWrap: "wrap",
          gap: 28,
        }}
      >
        <div
          style={{
            fontFamily: FONT_BLACK,
            fontSize: "clamp(26px,3.8vw,50px)",
            lineHeight: 1,
          }}
        >
          DETECT → UNDERSTAND
          <br />→ <span style={{ color: ROSE }}>DECIDE</span> →{" "}
          <span style={{ color: GOLD }}>PROTECT</span>
        </div>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: "0.12em",
            color: MUTE,
            lineHeight: 2,
          }}
        >
          AI RISK INTELLIGENCE
          <br />
          AI RISK GUARDIAN
          <br />
          ONCHAIN EXECUTION ON X LAYER
        </div>
      </footer>
    </main>
  );
}
