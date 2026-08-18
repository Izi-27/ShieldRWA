import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Mints RWA tokens and deposits them into the RWAPosition vault.
 *
 * Deploying the protection layer leaves the vault empty. With no assets,
 * `totalAssets()` is zero, every computed rotation rounds to zero, and
 * `executeProtection` correctly reverts with `ZeroAmount()` — the contracts are
 * fine, there is simply nothing to protect.
 *
 * Run with: npm run fund:xlayer [-- <amount>]   (default 10000)
 */
async function main() {
  const amountArg = process.argv[2];
  const amount = amountArg ? Number(amountArg) : 10_000;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid amount: ${amountArg}`);
  }

  const bookPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(bookPath)) {
    throw new Error(`No deployment found at ${bookPath} — run the deploy script first.`);
  }
  const book = JSON.parse(fs.readFileSync(bookPath, "utf8")) as {
    contracts: Record<string, string>;
  };

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer — set DEPLOYER_PRIVATE_KEY in contracts/.env");

  const rwa = await ethers.getContractAt("MockERC20", book.contracts.rwaToken!, signer);
  const vault = await ethers.getContractAt("RWAPosition", book.contracts.rwaPosition!, signer);

  const decimals = await rwa.decimals();
  const units = ethers.parseUnits(String(amount), decimals);

  console.log(`\nFunding ${book.contracts.rwaPosition} on ${network.name}\n`);
  console.log(`  Depositor      ${signer.address}`);
  console.log(`  Amount         ${amount} ${await rwa.symbol()}`);

  const before = await vault.totalAssets();
  console.log(`  Vault before   ${ethers.formatUnits(before, decimals)}`);

  // The mock token mints freely; a real RWA would already be held.
  console.log("\n  minting…");
  await (await rwa.mint(signer.address, units)).wait();

  console.log("  approving…");
  await (await rwa.approve(await vault.getAddress(), units)).wait();

  console.log("  depositing…");
  const receipt = await (await vault.deposit(units, signer.address)).wait();

  const after = await vault.totalAssets();
  const shares = await vault.balanceOf(signer.address);

  console.log(`\n  Vault after    ${ethers.formatUnits(after, decimals)}`);
  console.log(`  Shares held    ${ethers.formatUnits(shares, await vault.decimals())}`);
  console.log(`  Tx             ${receipt?.hash}`);

  // The executor caps a single rotation, so confirm a realistic slice is
  // actually executable rather than leaving that to be discovered at runtime.
  const executor = await ethers.getContractAt(
    "ProtectionExecutor",
    book.contracts.protectionExecutor!,
    signer,
  );
  const maxBps = await executor.maxRotationBps();
  const largest = (after * BigInt(maxBps)) / 10_000n;
  console.log(
    `\n  Largest single rotation permitted: ${ethers.formatUnits(largest, decimals)} ` +
      `(${Number(maxBps) / 100}% of the vault)`,
  );
  console.log("\n✓ Vault funded — protective execution can now run.\n");
}

main().catch((err) => {
  console.error("\n✗ Funding failed:\n", err);
  process.exitCode = 1;
});
