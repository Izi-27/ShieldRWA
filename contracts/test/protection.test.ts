import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const ACTION = { HOLD: 0, REDUCE: 1, HEDGE: 2, EXIT: 3 } as const;
const BAND = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const;

const RWA_DECIMALS = 18;
const USDC_DECIMALS = 6;
const STALENESS = 15 * 60; // 15 minutes

async function deployFixture() {
  const [admin, investor, guardian, outsider] = await ethers.getSigners();

  const Token = await ethers.getContractFactory("MockERC20");
  const rwa = await Token.deploy("RWA Treasury Note T3", "RWA-T3", RWA_DECIMALS);
  const usdc = await Token.deploy("USD Coin", "USDC", USDC_DECIMALS);

  const Oracle = await ethers.getContractFactory("RiskOracle");
  const oracle = await Oracle.deploy(admin.address, STALENESS);

  const Vault = await ethers.getContractFactory("RWAPosition");
  const vault = await Vault.deploy(
    await rwa.getAddress(),
    await usdc.getAddress(),
    "ShieldRWA Protected RWA-T3",
    "sRWA-T3",
    admin.address,
  );

  const Executor = await ethers.getContractFactory("ProtectionExecutor");
  const executor = await Executor.deploy(await oracle.getAddress(), admin.address);

  const Router = await ethers.getContractFactory("MockDexRouter");
  const router = await Router.deploy(140); // 1.4% slippage

  await vault.grantRole(await vault.EXECUTOR_ROLE(), await executor.getAddress());
  await executor.grantRole(await executor.GUARDIAN_ROLE(), guardian.address);
  await executor.setRouterAllowed(await router.getAddress(), true);

  // Seed the investor and open a $10,000 position.
  const deposit = ethers.parseUnits("10000", RWA_DECIMALS);
  await rwa.mint(investor.address, deposit);
  await rwa.connect(investor).approve(await vault.getAddress(), deposit);
  await vault.connect(investor).deposit(deposit, investor.address);

  return { admin, investor, guardian, outsider, rwa, usdc, oracle, vault, executor, router, deposit };
}

async function anchor(
  oracle: any,
  vault: any,
  score: number,
  action: number = ACTION.HOLD,
  confidence = 85,
  escalation = 40,
) {
  return oracle.anchor(
    await vault.getAddress(),
    score,
    confidence,
    escalation,
    action,
    ethers.keccak256(ethers.toUtf8Bytes(`reasoning-${score}`)),
  );
}

describe("RWAPosition", () => {
  it("mints shares 1:1 on the first deposit and reports total assets", async () => {
    const { vault, deposit, investor } = await loadFixture(deployFixture);
    expect(await vault.totalAssets()).to.equal(deposit);
    expect(await vault.balanceOf(investor.address)).to.equal(deposit);
  });

  it("counts the defensive leg toward total assets at the configured price", async () => {
    const { vault, usdc, deposit } = await loadFixture(deployFixture);
    // 1,000 USDC arrives in the vault out of band.
    await usdc.mint(await vault.getAddress(), ethers.parseUnits("1000", USDC_DECIMALS));
    expect(await vault.defensiveInAssetUnits()).to.equal(ethers.parseUnits("1000", RWA_DECIMALS));
    expect(await vault.totalAssets()).to.equal(deposit + ethers.parseUnits("1000", RWA_DECIMALS));
  });

  it("rejects a defensive price outside the sanity band", async () => {
    const { vault } = await loadFixture(deployFixture);
    await expect(vault.setDefensivePrice(ethers.parseUnits("3", 18)))
      .to.be.revertedWithCustomError(vault, "PriceOutOfRange");
  });

  it("only lets the executor role check assets out", async () => {
    const { vault, outsider } = await loadFixture(deployFixture);
    await expect(
      vault.connect(outsider).checkoutForProtection(ethers.parseUnits("1", RWA_DECIMALS)),
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
  });

  it("lets the investor withdraw the RWA leg", async () => {
    const { vault, investor, rwa } = await loadFixture(deployFixture);
    const out = ethers.parseUnits("2500", RWA_DECIMALS);
    await vault.connect(investor).withdraw(out, investor.address, investor.address);
    expect(await rwa.balanceOf(investor.address)).to.equal(out);
  });
});

describe("RiskOracle", () => {
  it("anchors an assessment and maps the score onto a band", async () => {
    const { oracle, vault } = await loadFixture(deployFixture);
    await anchor(oracle, vault, 74, ACTION.EXIT);

    const a = await oracle.latestAssessment(await vault.getAddress());
    expect(a.score).to.equal(74);
    expect(a.recommended).to.equal(ACTION.EXIT);
    expect(await oracle.bandOf(74)).to.equal(BAND.HIGH);
    expect(await oracle.bandOf(18)).to.equal(BAND.LOW);
    expect(await oracle.bandOf(95)).to.equal(BAND.CRITICAL);
    expect(await oracle.assessmentCount(await vault.getAddress())).to.equal(1);
  });

  it("rejects out-of-range scores", async () => {
    const { oracle, vault } = await loadFixture(deployFixture);
    await expect(anchor(oracle, vault, 101)).to.be.revertedWithCustomError(
      oracle,
      "ScoreOutOfRange",
    );
  });

  it("refuses anchoring from a non-reporter", async () => {
    const { oracle, vault, outsider } = await loadFixture(deployFixture);
    await expect(
      oracle
        .connect(outsider)
        .anchor(await vault.getAddress(), 20, 80, 20, ACTION.HOLD, ethers.ZeroHash),
    ).to.be.revertedWithCustomError(oracle, "AccessControlUnauthorizedAccount");
  });

  it("reports staleness once the window elapses", async () => {
    const { oracle, vault } = await loadFixture(deployFixture);
    await anchor(oracle, vault, 30);
    expect(await oracle.isFresh(await vault.getAddress())).to.equal(true);
    await time.increase(STALENESS + 1);
    expect(await oracle.isFresh(await vault.getAddress())).to.equal(false);
  });
});

describe("ProtectionExecutor", () => {
  it("executes the rotation, returns proceeds to the vault and logs the event", async () => {
    const { oracle, vault, executor, guardian, router, usdc, deposit } =
      await loadFixture(deployFixture);
    await anchor(oracle, vault, 74, ACTION.EXIT);

    const assetsIn = (deposit * 35n) / 100n; // 3,500 RWA
    const minOut = ethers.parseUnits("3400", USDC_DECIMALS);
    const reasoningHash = ethers.keccak256(ethers.toUtf8Bytes("rotate 35% into USDC"));

    const tx = await executor.connect(guardian).executeProtection({
      position: await vault.getAddress(),
      assetsIn,
      minDefensiveOut: minOut,
      router: await router.getAddress(),
      action: ACTION.REDUCE,
      reasoningHash,
    });

    // 3,500 less 1.4% slippage = 3,451 USDC
    const expectedOut = ethers.parseUnits("3451", USDC_DECIMALS);
    await expect(tx)
      .to.emit(executor, "ProtectionExecuted")
      .withArgs(0, await vault.getAddress(), ACTION.REDUCE, assetsIn, expectedOut, 74, 74, reasoningHash);

    expect(await usdc.balanceOf(await vault.getAddress())).to.equal(expectedOut);
    expect(await vault.pendingProtection()).to.equal(0);
    expect(await executor.totalProtected(await vault.getAddress())).to.equal(assetsIn);

    // Vault value = 6,500 RWA + 3,451 USDC valued 1:1 = 9,951 (the slippage cost).
    expect(await vault.totalAssets()).to.equal(ethers.parseUnits("9951", RWA_DECIMALS));
    expect(await vault.defensiveShareBps()).to.be.closeTo(3468n, 5n);

    const logged = await executor.eventAt(0);
    expect(logged.action).to.equal(ACTION.REDUCE);
    expect(logged.riskBefore).to.equal(74);
    expect(logged.reasoningHash).to.equal(reasoningHash);
    expect(await executor.eventIdsFor(await vault.getAddress())).to.deep.equal([0n]);
  });

  it("refuses to act on a stale assessment", async () => {
    const { oracle, vault, executor, guardian, router, deposit } = await loadFixture(deployFixture);
    await anchor(oracle, vault, 74, ACTION.EXIT);
    await time.increase(STALENESS + 1);

    await expect(
      executor.connect(guardian).executeProtection({
        position: await vault.getAddress(),
        assetsIn: (deposit * 35n) / 100n,
        minDefensiveOut: 0,
        router: await router.getAddress(),
        action: ACTION.REDUCE,
        reasoningHash: ethers.ZeroHash,
      }),
    ).to.be.revertedWithCustomError(executor, "StaleAssessment");
  });

  it("refuses an unallowlisted venue", async () => {
    const { oracle, vault, executor, guardian, deposit, outsider } = await loadFixture(deployFixture);
    await anchor(oracle, vault, 74, ACTION.EXIT);

    await expect(
      executor.connect(guardian).executeProtection({
        position: await vault.getAddress(),
        assetsIn: (deposit * 35n) / 100n,
        minDefensiveOut: 0,
        router: outsider.address,
        action: ACTION.REDUCE,
        reasoningHash: ethers.ZeroHash,
      }),
    ).to.be.revertedWithCustomError(executor, "RouterNotAllowed");
  });

  it("caps a single rotation at maxRotationBps", async () => {
    const { oracle, vault, executor, guardian, router, deposit } = await loadFixture(deployFixture);
    await anchor(oracle, vault, 90, ACTION.EXIT);

    await expect(
      executor.connect(guardian).executeProtection({
        position: await vault.getAddress(),
        assetsIn: (deposit * 60n) / 100n, // 6,000 > 50% cap
        minDefensiveOut: 0,
        router: await router.getAddress(),
        action: ACTION.EXIT,
        reasoningHash: ethers.ZeroHash,
      }),
    ).to.be.revertedWithCustomError(executor, "RotationTooLarge");
  });

  it("reverts when the swap cannot clear the minimum output", async () => {
    const { oracle, vault, executor, guardian, router, deposit } = await loadFixture(deployFixture);
    await anchor(oracle, vault, 74, ACTION.EXIT);
    await router.setSlippageBps(2000); // 20% — far worse than the Guardian modelled

    await expect(
      executor.connect(guardian).executeProtection({
        position: await vault.getAddress(),
        assetsIn: (deposit * 35n) / 100n,
        minDefensiveOut: ethers.parseUnits("3400", USDC_DECIMALS),
        router: await router.getAddress(),
        action: ACTION.REDUCE,
        reasoningHash: ethers.ZeroHash,
      }),
    ).to.be.reverted;
  });

  it("rejects HOLD and HEDGE — the executor only performs rotations", async () => {
    const { oracle, vault, executor, guardian, router, deposit } = await loadFixture(deployFixture);
    await anchor(oracle, vault, 40, ACTION.HOLD);

    await expect(
      executor.connect(guardian).executeProtection({
        position: await vault.getAddress(),
        assetsIn: (deposit * 10n) / 100n,
        minDefensiveOut: 0,
        router: await router.getAddress(),
        action: ACTION.HOLD,
        reasoningHash: ethers.ZeroHash,
      }),
    ).to.be.revertedWithCustomError(executor, "UnsupportedAction");
  });

  it("refuses execution from an address without the guardian role", async () => {
    const { oracle, vault, executor, outsider, router, deposit } = await loadFixture(deployFixture);
    await anchor(oracle, vault, 74, ACTION.EXIT);

    await expect(
      executor.connect(outsider).executeProtection({
        position: await vault.getAddress(),
        assetsIn: (deposit * 35n) / 100n,
        minDefensiveOut: 0,
        router: await router.getAddress(),
        action: ACTION.REDUCE,
        reasoningHash: ethers.ZeroHash,
      }),
    ).to.be.revertedWithCustomError(executor, "AccessControlUnauthorizedAccount");
  });
});
