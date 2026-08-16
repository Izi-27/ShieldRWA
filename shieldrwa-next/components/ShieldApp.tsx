"use client";

import { CREAM, DARK, FONT_MONO, FONT_SANS, GOLD, MUTE, RED } from "@/lib/theme";
import { useLiveShield } from "@/lib/useLiveShield";
import Dashboard from "./Dashboard";
import DecisionModal from "./DecisionModal";
import Header from "./Header";
import Landing from "./Landing";
import Onboarding from "./Onboarding";
import Policy from "./Policy";
import ProofLog from "./ProofLog";
import StatusBar from "./StatusBar";
import EmptyState from "./EmptyState";

export default function ShieldApp() {
  const vm = useLiveShield();

  // Views that need a registered position redirect to onboarding rather than
  // rendering an empty dashboard.
  const needsPosition = (vm.isDash || vm.isPolicy || vm.isProof) && !vm.hasPosition;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: DARK,
        color: CREAM,
        fontFamily: FONT_SANS,
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <Header vm={vm} />
      <StatusBar vm={vm} />

      {vm.authError && (
        <div
          role="alert"
          style={{
            padding: "12px 34px",
            background: "rgba(214,75,62,0.14)",
            borderBottom: `1px solid ${RED}`,
            fontFamily: FONT_MONO,
            fontSize: 11.5,
            letterSpacing: "0.08em",
            color: "#F0BBB4",
          }}
        >
          {vm.authError}
        </div>
      )}

      {vm.isLanding && <Landing vm={vm} />}
      {vm.isOnboard && <Onboarding vm={vm} />}

      {needsPosition ? (
        <EmptyState
          title={vm.connected ? "NO POSITION REGISTERED" : "CONNECT TO CONTINUE"}
          body={
            vm.connected
              ? "Register an RWA position and the protection loop starts scoring it immediately."
              : "Sign in with your wallet to register a position and start the protection loop."
          }
          ctaLabel={vm.connected ? "REGISTER POSITION" : "CONNECT WALLET"}
          onCta={vm.connected ? () => void vm.registerPosition() : () => void vm.connect()}
          busy={vm.busy === "register" || vm.connection === "connecting"}
        />
      ) : (
        <>
          {vm.isDash && <Dashboard vm={vm} />}
          {vm.isPolicy && <Policy vm={vm} />}
          {vm.isProof && <ProofLog vm={vm} />}
        </>
      )}

      {vm.modalOpen && vm.modal && <DecisionModal vm={vm} />}
    </div>
  );
}

export type { LiveShieldVM as ShieldVM } from "@/lib/useLiveShield";
export { GOLD, MUTE };
