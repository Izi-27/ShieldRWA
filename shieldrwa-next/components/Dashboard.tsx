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
import { HoverButton } from "./Hover";

export default function Dashboard({ vm }: { vm: LiveShieldVM }) {
  return (
    <main
      style={{ display: "grid", gridTemplateColumns: "150px 1fr 380px", gap: 0 }}
    >
      {/* ---- protection loop spine ---- */}
      <aside
        style={{
          display: "flex",
          flexDirection: "column",
          position: "sticky",
          top: 60,
          height: "calc(100vh - 60px)",
          padding: "20px 0 20px 34px",
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.16em",
            color: MUTE,
            marginBottom: 20,
          }}
        >
          PROTECTION LOOP
        </div>
        {vm.spine.map((p) => (
          <div
            key={p.n}
            style={{
              flex: 1,
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
              padding: "4px 0",
              color: p.fg,
              transition: "color .3s",
            }}
          >
            <div
              style={{
                width: 3,
                alignSelf: "stretch",
                background: p.bar,
                transition: "background .3s",
              }}
            />
            <div>
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  letterSpacing: "0.14em",
                  color: MUTE,
                }}
              >
                {p.n}
              </div>
              <div
                style={{
                  width: 9,
                  height: 9,
                  background: p.dot,
                  animation: p.anim,
                  margin: "10px 0 8px",
                }}
              />
              <div style={{ fontFamily: FONT_BLACK, fontSize: 14 }}>
                {p.title}
              </div>
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 9.5,
                  letterSpacing: "0.1em",
                  marginTop: 5,
                  color: p.statusC,
                }}
              >
                {p.status}
              </div>
            </div>
          </div>
        ))}
      </aside>

      {/* ---- main column ---- */}
      <section style={{ padding: "20px 34px 48px" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
            paddingBottom: 20,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <div style={{ fontFamily: FONT_BLACK, fontSize: 20 }}>
              {vm.position.name}
            </div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: "0.1em",
                color: MUTE,
              }}
            >
              {vm.position.contract}
            </div>
          </div>
          <HoverButton
            onClick={vm.triggerEvent}
            hoverStyle={{ color: GOLD, borderColor: GOLD, gap: 20 }}
            style={{
              appearance: "none",
              background: vm.triggerBg,
              backgroundImage: vm.triggerStripes,
              backgroundSize: "56px 56px",
              animation: vm.triggerAnim,
              border: 0,
              borderBottom: `2px solid ${vm.triggerRule}`,
              color: vm.triggerFg,
              fontFamily: FONT_MONO,
              fontSize: 11.5,
              letterSpacing: "0.16em",
              padding: "8px 0 10px",
              cursor: "pointer",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 14,
              transition: "color .18s,border-color .18s,gap .18s",
            }}
          >
            {vm.triggerLabel}
          </HoverButton>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 24,
            flexWrap: "wrap",
            paddingTop: 8,
          }}
        >
          <div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.2em",
                color: MUTE,
              }}
            >
              COMPOSITE RISK SCORE
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 18,
                marginTop: 8,
              }}
            >
              <div
                style={{
                  fontFamily: FONT_BLACK,
                  fontSize: 104,
                  lineHeight: 0.84,
                  letterSpacing: "-0.035em",
                  color: vm.bandColor,
                  fontVariantNumeric: "tabular-nums",
                  transition: "color .4s",
                }}
              >
                {vm.riskDisplay}
              </div>
              <div>
                <div
                  style={{
                    fontFamily: FONT_BLACK,
                    fontSize: 26,
                    color: vm.bandColor,
                    transition: "color .4s",
                  }}
                >
                  {vm.bandLabel}
                </div>
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: MUTE,
                    marginTop: 5,
                  }}
                >
                  Δ {vm.riskDelta} / 1H
                </div>
              </div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.2em",
                color: MUTE,
              }}
            >
              POSITION VALUE
            </div>
            <div
              style={{
                fontFamily: FONT_BLACK,
                fontSize: 40,
                marginTop: 8,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {vm.position.value}
            </div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: ROSE,
                marginTop: 5,
              }}
            >
              POLICY · {vm.policyLabel}
            </div>
          </div>
        </div>

        {/* ---- risk meter ---- */}
        <div
          style={{
            display: "flex",
            gap: 2,
            marginTop: 28,
            height: 48,
            alignItems: "flex-end",
          }}
        >
          {vm.meter.map((m, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: m.h,
                background: m.c,
                transition: "height .2s,background .2s",
              }}
            />
          ))}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: FONT_MONO,
            fontSize: 9.5,
            letterSpacing: "0.12em",
            color: MUTE,
            marginTop: 9,
          }}
        >
          <span>00 LOW</span>
          <span>25</span>
          <span>50 MEDIUM</span>
          <span>75 HIGH</span>
          <span>100 CRITICAL</span>
        </div>

        {/* ---- forecast ---- */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto",
            gap: 28,
            alignItems: "center",
            marginTop: 30,
          }}
        >
          <div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.18em",
                color: MUTE,
              }}
            >
              PREDICTED TRAJECTORY · 6H HORIZON
            </div>
            <div
              style={{
                display: "flex",
                gap: 2,
                marginTop: 12,
                height: 30,
                alignItems: "flex-end",
              }}
            >
              {vm.forecast.map((f, i) => (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    height: f.h,
                    background: f.c,
                    opacity: f.o,
                    transition: "height .3s",
                  }}
                />
              ))}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                fontFamily: FONT_BLACK,
                fontSize: 32,
                color: vm.bandColor,
                transition: "color .4s",
              }}
            >
              {vm.escalation}
            </div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                color: MUTE,
                letterSpacing: "0.12em",
              }}
            >
              P(ESCALATION)
            </div>
          </div>
        </div>

        {/* ---- signal classes ---- */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))",
            gap: 32,
            marginTop: 44,
            paddingTop: 26,
            borderTop: "1px solid #2A2325",
          }}
        >
          {vm.signals.map((sg) => (
            <div key={sg.label}>
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 9.5,
                  letterSpacing: "0.14em",
                  color: MUTE,
                }}
              >
                {sg.label}
              </div>
              <div
                style={{
                  fontFamily: FONT_BLACK,
                  fontSize: 30,
                  marginTop: 8,
                  color: sg.color,
                  fontVariantNumeric: "tabular-nums",
                  transition: "color .3s",
                }}
              >
                {sg.value}
              </div>
              <div
                style={{ height: 4, background: "#2A2325", marginTop: 10 }}
              >
                <div
                  style={{
                    height: 4,
                    width: sg.w,
                    background: sg.color,
                    transition: "width .5s,background .3s",
                  }}
                />
              </div>
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  marginTop: 9,
                  color: MUTE,
                }}
              >
                {sg.note}
              </div>
            </div>
          ))}
        </div>

        {/* ---- AI risk analyst ---- */}
        <div
          style={{
            marginTop: 48,
            paddingTop: 26,
            borderTop: "1px solid #2A2325",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 11, height: 11, background: ROSE }} />
              <div style={{ fontFamily: FONT_BLACK, fontSize: 21 }}>
                AI RISK ANALYST
              </div>
            </div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: "0.12em",
                color: MUTE,
              }}
            >
              CONFIDENCE {vm.analyst.confidence}
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))",
              gap: 48,
              marginTop: 22,
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  letterSpacing: "0.16em",
                  color: MUTE,
                  marginBottom: 16,
                }}
              >
                TOP CONTRIBUTING FACTORS
              </div>
              {vm.analyst.factors.map((f) => (
                <div
                  key={f.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    marginBottom: 13,
                  }}
                >
                  <div
                    style={{
                      flex: 1,
                      fontFamily: FONT_MONO,
                      fontSize: 11.5,
                      color: "#E4DAD3",
                    }}
                  >
                    {f.label}
                  </div>
                  <div style={{ width: 100, height: 4, background: "#2A2325" }}>
                    <div
                      style={{
                        height: 4,
                        width: f.w,
                        background: f.c,
                        transition: "width .5s",
                      }}
                    />
                  </div>
                  <div
                    style={{
                      width: 38,
                      textAlign: "right",
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {f.pct}
                  </div>
                </div>
              ))}
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    letterSpacing: "0.16em",
                    color: MUTE,
                    marginBottom: 12,
                  }}
                >
                  PLAIN-LANGUAGE REASONING
                </div>
                <div
                  style={{
                    fontSize: 14.5,
                    lineHeight: 1.55,
                    textWrap: "pretty",
                    color: "#E4DAD3",
                  }}
                >
                  {vm.analyst.reasoning}
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 14,
                  marginTop: 20,
                }}
              >
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    letterSpacing: "0.16em",
                    color: MUTE,
                  }}
                >
                  RECOMMENDS
                </span>
                <span
                  style={{
                    fontFamily: FONT_BLACK,
                    fontSize: 26,
                    color: CREAM,
                  }}
                >
                  {vm.analyst.action}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* ---- AI risk guardian ---- */}
        <div
          style={{
            marginTop: 48,
            paddingTop: 26,
            borderTop: "1px solid #2A2325",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 11, height: 11, background: GOLD }} />
              <div style={{ fontFamily: FONT_BLACK, fontSize: 21 }}>
                AI RISK GUARDIAN
              </div>
            </div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: "0.12em",
                color: MUTE,
              }}
            >
              CHALLENGE LAYER
            </div>
          </div>
          <div
            style={{
              fontSize: 15,
              lineHeight: 1.55,
              marginTop: 18,
              maxWidth: "76ch",
              textWrap: "pretty",
              color: vm.guardian.fg,
              transition: "color .3s",
            }}
          >
            {vm.guardian.text}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))",
              gap: 32,
              marginTop: 24,
            }}
          >
            {vm.guardian.checks.map((c) => (
              <div key={c.k}>
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 9.5,
                    letterSpacing: "0.14em",
                    color: MUTE,
                  }}
                >
                  {c.k}
                </div>
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 14,
                    marginTop: 9,
                    fontWeight: 600,
                    color: c.c,
                  }}
                >
                  {c.v}
                </div>
              </div>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 14,
              marginTop: 26,
            }}
          >
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.16em",
                color: MUTE,
              }}
            >
              FINAL DECISION
            </span>
            <span
              style={{ fontFamily: FONT_BLACK, fontSize: 30, color: ROSE }}
            >
              {vm.guardian.decision}
            </span>
          </div>
        </div>
      </section>

      {/* ---- policy + event feed ---- */}
      <aside
        style={{
          display: "flex",
          flexDirection: "column",
          padding: "20px 34px 40px",
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.16em",
            color: MUTE,
          }}
        >
          PROTECTION POLICY
        </div>
        <div
          style={{
            fontFamily: FONT_BLACK,
            fontSize: 28,
            color: ROSE,
            marginTop: 12,
          }}
        >
          {vm.policyLabel}
        </div>
        <div
          style={{
            fontSize: 13.5,
            lineHeight: 1.5,
            marginTop: 8,
            color: BODY,
            fontFamily: FONT_SANS,
          }}
        >
          {vm.policyDesc}
        </div>
        <div style={{ marginTop: 18 }}>
          {vm.policySummary.map((r) => (
            <div
              key={r.k}
              style={{
                padding: "11px 0",
                display: "flex",
                justifyContent: "space-between",
                fontFamily: FONT_MONO,
                fontSize: 11.5,
                borderBottom: "1px solid #2A2325",
              }}
            >
              <span style={{ color: MUTE }}>{r.k}</span>
              <span style={{ fontWeight: 600 }}>{r.v}</span>
            </div>
          ))}
        </div>
        <HoverButton
          onClick={vm.goPolicy}
          hoverStyle={{ color: GOLD, borderColor: GOLD, gap: 20 }}
          style={{
            appearance: "none",
            background: "none",
            border: 0,
            borderBottom: "2px solid #7F5461",
            color: ROSE,
            fontFamily: FONT_MONO,
            fontSize: 11.5,
            letterSpacing: "0.16em",
            padding: "0 0 11px",
            cursor: "pointer",
            marginTop: 22,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 14,
            transition: "color .18s,border-color .18s,gap .18s",
          }}
        >
          EDIT POLICY<span>→</span>
        </HoverButton>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 44,
            paddingBottom: 12,
            borderBottom: "1px solid #2A2325",
          }}
        >
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.16em",
              color: MUTE,
            }}
          >
            EVENT FEED
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontFamily: FONT_MONO,
              fontSize: 10,
              color: GOLD,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                background: GOLD,
                animation: "shBlink 1.4s steps(1,end) infinite",
              }}
            />
            LIVE
          </span>
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {vm.feed.map((e, i) => (
            <div
              key={`${e.time}-${i}-${e.text}`}
              style={{
                padding: "13px 0",
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
                animation: "shRise .3s ease-out",
                borderBottom: "1px solid #201A1C",
              }}
            >
              <div
                style={{
                  width: 6,
                  height: 6,
                  background: e.c,
                  marginTop: 5,
                  flex: "none",
                }}
              />
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 11.5,
                    lineHeight: 1.45,
                    color: "#E4DAD3",
                  }}
                >
                  {e.text}
                </div>
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    color: MUTE,
                    marginTop: 4,
                  }}
                >
                  {e.time}
                </div>
              </div>
            </div>
          ))}
        </div>
      </aside>
    </main>
  );
}
