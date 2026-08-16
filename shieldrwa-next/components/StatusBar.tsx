"use client";

import { FONT_MONO, GOLD, GREEN, MUTE, ROSE } from "@/lib/theme";
import type { LiveShieldVM } from "@/lib/useLiveShield";

/**
 * A thin honesty strip. It states plainly whether the chain is connected,
 * whether the AI models are in play, and whether market data is live — so the
 * dashboard never implies more than the running configuration delivers.
 */
export default function StatusBar({ vm }: { vm: LiveShieldVM }) {
  const chain = vm.health?.chain;
  const ai = vm.health?.ai;

  const items: { label: string; value: string; color: string }[] = [
    {
      label: "CHAIN",
      value: !chain
        ? "UNKNOWN"
        : chain.available
          ? chain.canSign
            ? `CONNECTED · CHAIN ${chain.chainId}`
            : `READ-ONLY · CHAIN ${chain.chainId}`
          : "NOT CONFIGURED",
      color: chain?.available ? (chain.canSign ? GREEN : GOLD) : MUTE,
    },
    {
      label: "AI",
      value: ai?.enabled ? `${ai.model}` : "DETERMINISTIC FALLBACK",
      color: ai?.enabled ? GREEN : GOLD,
    },
    {
      label: "MARKET DATA",
      value: vm.health?.marketData === "coingecko" ? "LIVE" : "SIMULATED",
      color: vm.health?.marketData === "coingecko" ? GREEN : GOLD,
    },
    {
      label: "STREAM",
      value: vm.live ? "LIVE" : vm.connected ? "RECONNECTING" : "OFFLINE",
      color: vm.live ? GREEN : MUTE,
    },
  ];

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 28,
        padding: "8px 34px",
        borderBottom: "1px solid #2A2325",
        background: "#141011",
        fontFamily: FONT_MONO,
        fontSize: 10,
        letterSpacing: "0.14em",
      }}
    >
      {items.map((item) => (
        <span key={item.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: MUTE }}>{item.label}</span>
          <span
            style={{
              width: 6,
              height: 6,
              background: item.color,
              animation:
                item.label === "STREAM" && vm.live
                  ? "shBlink 1.4s steps(1,end) infinite"
                  : "none",
            }}
          />
          <span style={{ color: item.color }}>{item.value}</span>
        </span>
      ))}
      {vm.address && (
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ color: ROSE }}>
            {vm.address.slice(0, 6)}…{vm.address.slice(-4)}
          </span>
          <button
            onClick={vm.disconnect}
            style={{
              appearance: "none",
              border: 0,
              background: "none",
              color: MUTE,
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.14em",
              cursor: "pointer",
              padding: 0,
            }}
          >
            DISCONNECT
          </button>
        </span>
      )}
    </div>
  );
}
