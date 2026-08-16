import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys the ShieldRWA protection layer and writes an address book the
 * backend reads at boot.
 *
 * Env overrides (all optional — mocks are deployed when absent):
 *   RWA_TOKEN_ADDRESS      existing RWA token to protect
 *   DEFENSIVE_TOKEN_ADDRESS existing stablecoin for defensive rotations
 *   DEX_ROUTER_ADDRESS     OKX DEX router to allowlist
 *   GUARDIAN_ADDRESS       backend signer granted GUARDIAN_ROLE / REPORTER_ROLE
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const guardian = process.env.GUARDIAN_ADDRESS ?? deployer.address;

  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Guardian: ${guardian}`);

  const Token = await ethers.getContractFactory("MockERC20");

  let rwaAddress = process.env.RWA_TOKEN_ADDRESS;
  if (!rwaAddress) {
    const rwa = await Token.deploy("RWA Treasury Note T3", "RWA-T3", 18);
    await rwa.waitForDeployment();
    rwaAddress = await rwa.getAddress();
    console.log(`  MockERC20 (RWA-T3)   ${rwaAddress}`);
  }

  let defensiveAddress = process.env.DEFENSIVE_TOKEN_ADDRESS;
  if (!defensiveAddress) {
    const usdc = await Token.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();
    defensiveAddress = await usdc.getAddress();
    console.log(`  MockERC20 (USDC)     ${defensiveAddress}`);
  }

  const Oracle = await ethers.getContractFactory("RiskOracle");
  const oracle = await Oracle.deploy(deployer.address, 15 * 60);
  await oracle.waitForDeployment();
  console.log(`  RiskOracle           ${await oracle.getAddress()}`);

  const Vault = await ethers.getContractFactory("RWAPosition");
  const vault = await Vault.deploy(
    rwaAddress,
    defensiveAddress,
    "ShieldRWA Protected RWA-T3",
    "sRWA-T3",
    deployer.address,
  );
  await vault.waitForDeployment();
  console.log(`  RWAPosition          ${await vault.getAddress()}`);

  const Executor = await ethers.getContractFactory("ProtectionExecutor");
  const executor = await Executor.deploy(await oracle.getAddress(), deployer.address);
  await executor.waitForDeployment();
  console.log(`  ProtectionExecutor   ${await executor.getAddress()}`);

  let routerAddress = process.env.DEX_ROUTER_ADDRESS;
  if (!routerAddress) {
    const Router = await ethers.getContractFactory("MockDexRouter");
    const router = await Router.deploy(140);
    await router.waitForDeployment();
    routerAddress = await router.getAddress();
    console.log(`  MockDexRouter        ${routerAddress}`);
  }

  // Wire permissions: the vault trusts the executor, the executor and oracle
  // trust the backend guardian signer.
  await (await vault.grantRole(await vault.EXECUTOR_ROLE(), await executor.getAddress())).wait();
  await (await executor.grantRole(await executor.GUARDIAN_ROLE(), guardian)).wait();
  await (await oracle.grantRole(await oracle.REPORTER_ROLE(), guardian)).wait();
  await (await executor.setRouterAllowed(routerAddress, true)).wait();
  console.log("  roles + router allowlist wired");

  const book = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    guardian,
    contracts: {
      rwaToken: rwaAddress,
      defensiveToken: defensiveAddress,
      riskOracle: await oracle.getAddress(),
      rwaPosition: await vault.getAddress(),
      protectionExecutor: await executor.getAddress(),
      dexRouter: routerAddress,
    },
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(book, null, 2));
  console.log(`\nAddress book → ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
