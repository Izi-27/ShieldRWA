"use client";

import { FONT_BLACK, FONT_MONO, GOLD, MUTE, ROSE } from "@/lib/theme";
import type { LiveShieldVM } from "@/lib/useLiveShield";
import { HoverButton } from "./Hover";

export default function Header({ vm }: { vm: LiveShieldVM }) {
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 24,
        background: "#171314",
        padding: "0 34px",
        height: 60,
        borderBottom: "1px solid #2A2325",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
        <div
          style={{
            width: 12,
            height: 12,
            background: "#7F5461",
            animation: "shPulse 2.4s steps(2,end) infinite",
          }}
        />
        <div
          style={{
            fontFamily: FONT_BLACK,
            fontSize: 17,
            letterSpacing: "0.02em",
          }}
        >
          SHIELDRWA
        </div>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.14em",
            color: MUTE,
            paddingTop: 2,
          }}
        >
          X LAYER · TESTNET
        </div>
      </div>

      <nav style={{ display: "flex", alignItems: "center", gap: 28 }}>
        {vm.nav.map((item) => (
          <HoverButton
            key={item.id}
            onClick={item.go}
            hoverStyle={{ color: GOLD }}
            style={{
              appearance: "none",
              border: 0,
              background: "none",
              padding: "20px 0 18px",
              color: item.fg,
              borderBottom: `2px solid ${item.ul}`,
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: "0.16em",
              cursor: "pointer",
              transition: "color .15s,border-color .2s",
            }}
          >
            {item.label}
          </HoverButton>
        ))}
        {/*
          Runs the real wallet handshake. This previously called `goOnboard`,
          which only changed the view — a leftover from the scripted mock, and
          the reason the button appeared to do nothing.
        */}
        <HoverButton
          onClick={vm.connected ? vm.goDash : () => void vm.connect()}
          disabled={vm.connection === "connecting"}
          title={
            vm.connected
              ? "Open the dashboard"
              : "Connect your wallet and sign in"
          }
          hoverStyle={{ color: GOLD }}
          style={{
            appearance: "none",
            border: 0,
            background: "none",
            color: ROSE,
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: "0.12em",
            fontWeight: 600,
            cursor: vm.connection === "connecting" ? "wait" : "pointer",
            padding: "20px 0 18px",
            transition: "color .15s",
          }}
        >
          {vm.walletLabel}
        </HoverButton>
      </nav>
    </header>
  );
}
