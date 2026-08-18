import { ethers, network } from "hardhat";

/**
 * Pre-deployment checks.
 *
 * Deploying six contracts and sending four role transactions is a lot to
 * discover a problem halfway through — a half-deployed layer has to be redone
 * from scratch because addresses are baked into each other. This verifies the
 * network, the signer and the balance first, and estimates the cost.
 *
 * Run with: npm run preflight
 */
async function main() {
  console.log("\nShieldRWA — deployment preflight\n");

  let failures = 0;
  const check = (ok: boolean, label: string, detail: string) => {
    console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(24)} ${detail}`);
    if (!ok) failures++;
  };

  // --- network ---
  const net = await ethers.provider.getNetwork();
  const configured = network.config.chainId;
  check(
    configured === undefined || Number(net.chainId) === configured,
    "Chain ID",
    `${net.chainId}${configured !== undefined ? ` (config expects ${configured})` : ""}`,
  );

  const block = await ethers.provider.getBlockNumber();
  check(block > 0, "RPC reachable", `block ${block}`);

  // --- signer ---
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) {
    check(false, "Deployer key", "no account — set DEPLOYER_PRIVATE_KEY in contracts/.env");
    console.log("\n✗ Cannot continue without a signer.\n");
    process.exit(1);
  }
  check(true, "Deployer", deployer.address);

  const guardian = process.env.GUARDIAN_ADDRESS ?? deployer.address;
  check(true, "Guardian (backend)", guardian);
  if (guardian.toLowerCase() === deployer.address.toLowerCase()) {
    console.log(
      "    ⚠ Guardian and deployer are the same key. The deployer holds\n" +
        "      DEFAULT_ADMIN_ROLE, so your backend would hold admin rights too.\n" +
        "      Prefer a separate GUARDIAN_ADDRESS — see the deploy guide.",
    );
  }

  // --- funds ---
  const balance = await ethers.provider.getBalance(deployer.address);
  const gasPrice = (await ethers.provider.getFeeData()).gasPrice ?? 0n;

  // Measured from the local test deployment: ~7.2M gas for six contracts plus
  // four role/allowlist transactions, with headroom.
  const estimatedGas = 9_000_000n;
  const estimatedCost = estimatedGas * gasPrice;

  check(
    balance > estimatedCost,
    "Balance",
    `${ethers.formatEther(balance)} (need ~${ethers.formatEther(estimatedCost)})`,
  );
  console.log(`    gas price ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

  if (balance === 0n) {
    console.log("\n    Fund this address from the X Layer testnet faucet, then re-run.");
  }

  console.log();
  if (failures === 0) {
    console.log("✓ Ready to deploy:  npm run deploy:xlayer\n");
    process.exit(0);
  }
  console.log(`✗ ${failures} check(s) failed — resolve before deploying.\n`);
  process.exit(1);
}

main().catch((err) => {
  console.error("\n✗ Preflight failed:\n", err);
  process.exitCode = 1;
});
