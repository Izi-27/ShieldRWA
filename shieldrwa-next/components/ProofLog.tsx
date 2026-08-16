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
import { HoverBox } from "./Hover";

const GRID = "110px 110px 1fr 130px 150px 170px";

export default function ProofLog({ vm }: { vm: LiveShieldVM }) {
  return (
    <main style={{ padding: "44px 34px 72px" }}>
      <div
        style={{
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
            PROTECTION HISTORY · X LAYER TESTNET
          </div>
          <h2
            style={{
              fontFamily: FONT_BLACK,
              fontSize: "clamp(30px,4.4vw,58px)",
              lineHeight: 1,
              margin: "16px 0 0",
            }}
          >
            EVERY ACTION,
            <br />
            WITH ITS REASONING.
          </h2>
        </div>
        <div style={{ display: "flex", gap: 52 }}>
          <div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.14em",
                color: MUTE,
              }}
            >
              CAPITAL PROTECTED
            </div>
            <div
              style={{
                fontFamily: FONT_BLACK,
                fontSize: 32,
                marginTop: 8,
                color: GOLD,
              }}
            >
              {vm.totalProtected}
            </div>
          </div>
          <div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: "0.14em",
                color: MUTE,
              }}
            >
              EVENTS
            </div>
            <div
              style={{ fontFamily: FONT_BLACK, fontSize: 32, marginTop: 8 }}
            >
              {vm.historyCount}
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: GRID,
          gap: 20,
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: "0.14em",
          color: MUTE,
          marginTop: 44,
          paddingBottom: 12,
          borderBottom: "1px solid #3B3033",
        }}
      >
        <div>TIME</div>
        <div>ACTION</div>
        <div>REASONING</div>
        <div>AMOUNT</div>
        <div>RISK BEFORE→AFTER</div>
        <div>TX HASH</div>
      </div>

      {vm.history.map((h, i) => (
        <HoverBox
          key={`${h.time}-${i}`}
          hoverStyle={{ color: CREAM }}
          style={{
            display: "grid",
            gridTemplateColumns: GRID,
            gap: 20,
            padding: "18px 0",
            borderBottom: "1px solid #201A1C",
            fontFamily: FONT_MONO,
            fontSize: 12,
            alignItems: "baseline",
            color: BODY,
            transition: "color .15s",
          }}
        >
          <div style={{ color: MUTE }}>{h.time}</div>
          <div style={{ fontFamily: FONT_BLACK, fontSize: 14, color: ROSE }}>
            {h.action}
          </div>
          <div
            style={{ fontFamily: FONT_SANS, fontSize: 14, lineHeight: 1.45 }}
          >
            {h.reason}
          </div>
          <div style={{ fontWeight: 600, color: CREAM }}>{h.amount}</div>
          <div>
            <span style={{ color: h.beforeC, fontWeight: 600 }}>{h.before}</span>{" "}
            → <span style={{ color: h.afterC, fontWeight: 600 }}>{h.after}</span>
          </div>
          <div
            style={{ color: GOLD, overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {h.tx}
          </div>
        </HoverBox>
      ))}
    </main>
  );
}
