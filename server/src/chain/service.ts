import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  toHex,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { ACTION_ENUM, type Action } from "../domain/types.js";
import { erc20Abi, protectionExecutorAbi, riskOracleAbi, rwaPositionAbi } from "./abis.js";

/**
 * Chain access for the protection layer.
 *
 * The server runs with or without a configured chain. When `available` is
 * false every method returns null and the pipeline records simulated events —
 * clearly labelled as such — so the product is usable before deployment and
 * honest about what it did.
 */

export interface VaultState {
  totalAssets: bigint;
  /**
   * The RWA leg only. A rotation can draw on this, never on totalAssets,
   * which also counts value already sitting in the defensive asset.
   */
  assetBalance: bigint;
  totalAssetsFormatted: number;
  defensiveShare: number;
  assetDecimals: number;
  defensiveDecimals: number;
  assetAddress: Address;
  defensiveAddress: Address;
}

/**
 * How long a vault-state read stays fresh. Deliberately below the pipeline
 * cycle so a settled rotation is picked up on the following pass.
 */
const VAULT_STATE_TTL_MS = 4_000;

export interface ExecuteResult {
  txHash: Hash;
  eventId?: number;
}

export class ChainService {
  readonly available: boolean;
  readonly canSign: boolean;

  private publicClient: PublicClient | null = null;
  private walletClient: WalletClient | null = null;
  private account: ReturnType<typeof privateKeyToAccount> | null = null;
  private decimalsCache = new Map<Address, number>();

  constructor() {
    this.available = config.chain.enabled;
    this.canSign = config.chain.canSign;

    if (!this.available) {
      logger.warn(
        "chain not configured — risk anchoring and protective execution will be simulated",
      );
      return;
    }

    const chain = defineChain({
      id: config.chain.chainId,
      name: config.chain.name,
      nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
      rpcUrls: { default: { http: [config.chain.rpcUrl!] } },
      blockExplorers: {
        default: { name: "Explorer", url: config.chain.explorerUrl },
      },
    });

    this.publicClient = createPublicClient({
      chain,
      transport: http(config.chain.rpcUrl!, { timeout: 20_000, retryCount: 2 }),
    }) as PublicClient;

    if (config.chain.guardianPrivateKey) {
      this.account = privateKeyToAccount(config.chain.guardianPrivateKey as `0x${string}`);
      this.walletClient = createWalletClient({
        account: this.account,
        chain,
        transport: http(config.chain.rpcUrl!, { timeout: 20_000, retryCount: 2 }),
      });
      logger.info({ guardian: this.account.address }, "chain signer ready");
    } else {
      logger.warn("no guardian key configured — chain reads only, no execution");
    }
  }

  get guardianAddress(): Address | null {
    return this.account?.address ?? null;
  }

  get explorerBase(): string {
    return config.chain.explorerUrl;
  }

  txUrl(hash: string): string {
    return `${config.chain.explorerUrl}/tx/${hash}`;
  }

  private vault(): Address {
    return config.chain.contracts.rwaPosition as Address;
  }

  /** The vault every position is protected through, for dedup keys upstream. */
  get vaultAddress(): Address | null {
    return (config.chain.contracts.rwaPosition as Address) ?? null;
  }

  /**
   * Serialises every state-changing call through one queue.
   *
   * The guardian is a single key, and the pipeline runs positions with
   * `Promise.all`. Two concurrent writes both read the same pending nonce from
   * the RPC, and one is rejected with "nonce too low / already known" — which
   * is exactly what the logs showed. Chaining the writes means each transaction
   * sees the nonce left by the one before it.
   *
   * Reads are not queued: they hold no nonce and would only be slowed down.
   */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    // A rejected link must not poison the queue for later writes.
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private writeQueue: Promise<unknown> = Promise.resolve();

  private async decimalsOf(token: Address): Promise<number> {
    const cached = this.decimalsCache.get(token);
    if (cached !== undefined) return cached;
    const decimals = (await this.publicClient!.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    })) as number;
    this.decimalsCache.set(token, decimals);
    return decimals;
  }

  /**
   * Reads live vault state, or null when the chain is unavailable.
   *
   * Cached briefly because every position is protected through the same vault:
   * without this, each cycle re-read identical state once per position — six
   * RPC round-trips each, against a public testnet endpoint, several times a
   * minute. The TTL is shorter than one cycle, so a rotation's effect is still
   * observed on the very next pass.
   */
  async readVaultState(): Promise<VaultState | null> {
    if (!this.available || !this.publicClient) return null;

    const cached = this.vaultStateCache;
    if (cached && Date.now() - cached.at < VAULT_STATE_TTL_MS) return cached.value;

    // Collapse concurrent callers onto one in-flight read.
    if (this.vaultStateInFlight) return this.vaultStateInFlight;

    this.vaultStateInFlight = this.readVaultStateUncached().finally(() => {
      this.vaultStateInFlight = null;
    });
    return this.vaultStateInFlight;
  }

  /** Drops the cache so the next read reflects a just-settled transaction. */
  invalidateVaultState(): void {
    this.vaultStateCache = null;
  }

  private vaultStateCache: { at: number; value: VaultState | null } | null = null;
  private vaultStateInFlight: Promise<VaultState | null> | null = null;

  private async readVaultStateUncached(): Promise<VaultState | null> {
    if (!this.available || !this.publicClient) return null;
    try {
      const vault = this.vault();
      const [totalAssets, defensiveBps, assetAddress, defensiveAddress] = await Promise.all([
        this.publicClient.readContract({
          address: vault,
          abi: rwaPositionAbi,
          functionName: "totalAssets",
        }) as Promise<bigint>,
        this.publicClient.readContract({
          address: vault,
          abi: rwaPositionAbi,
          functionName: "defensiveShareBps",
        }) as Promise<bigint>,
        this.publicClient.readContract({
          address: vault,
          abi: rwaPositionAbi,
          functionName: "asset",
        }) as Promise<Address>,
        this.publicClient.readContract({
          address: vault,
          abi: rwaPositionAbi,
          functionName: "defensiveAsset",
        }) as Promise<Address>,
      ]);

      const [assetDecimals, defensiveDecimals, assetBalance] = await Promise.all([
        this.decimalsOf(assetAddress),
        this.decimalsOf(defensiveAddress),
        this.publicClient!.readContract({
          address: assetAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [vault],
        }) as Promise<bigint>,
      ]);

      const value: VaultState = {
        totalAssets,
        assetBalance,
        totalAssetsFormatted: Number(totalAssets) / 10 ** assetDecimals,
        defensiveShare: Number(defensiveBps) / 10_000,
        assetDecimals,
        defensiveDecimals,
        assetAddress,
        defensiveAddress,
      };
      this.vaultStateCache = { at: Date.now(), value };
      return value;
    } catch (err) {
      logger.warn({ err: describeChainError(err) }, "vault state read failed");
      // Cache the failure too, briefly: hammering an RPC that just failed for
      // every position makes recovery slower, not faster.
      this.vaultStateCache = { at: Date.now(), value: null };
      return null;
    }
  }

  /** Shares held by an investor, converted to asset units. */
  async readInvestorPosition(owner: Address): Promise<{ shares: bigint; assets: bigint } | null> {
    if (!this.available || !this.publicClient) return null;
    try {
      const vault = this.vault();
      const shares = (await this.publicClient.readContract({
        address: vault,
        abi: rwaPositionAbi,
        functionName: "balanceOf",
        args: [owner],
      })) as bigint;
      const assets = (await this.publicClient.readContract({
        address: vault,
        abi: rwaPositionAbi,
        functionName: "convertToAssets",
        args: [shares],
      })) as bigint;
      return { shares, assets };
    } catch (err) {
      logger.warn({ err, owner }, "investor position read failed");
      return null;
    }
  }

  /** Anchors an assessment on the RiskOracle. Returns null when unavailable. */
  async anchorAssessment(input: {
    score: number;
    confidence: number;
    escalation: number;
    action: Action;
    reasoning: string;
  }): Promise<Hash | null> {
    if (!this.canSign || !this.walletClient || !this.publicClient || !this.account) return null;

    return this.serialize(async () => {
    try {
      const hash = await this.walletClient!.writeContract({
        address: config.chain.contracts.riskOracle as Address,
        abi: riskOracleAbi,
        functionName: "anchor",
        args: [
          this.vault(),
          Math.round(input.score),
          Math.round(input.confidence),
          Math.round(input.escalation),
          ACTION_ENUM[input.action],
          keccak256(toHex(input.reasoning)),
        ],
        account: this.account!,
        chain: this.walletClient!.chain,
      });
      await this.publicClient!.waitForTransactionReceipt({ hash, confirmations: 1 });
      logger.info({ hash, score: input.score }, "risk assessment anchored");
      return hash;
    } catch (err) {
      logger.error({ err: describeChainError(err) }, "risk anchoring failed");
      return null;
    }
    });
  }

  async isAssessmentFresh(): Promise<boolean> {
    if (!this.available || !this.publicClient) return false;
    try {
      return (await this.publicClient.readContract({
        address: config.chain.contracts.riskOracle as Address,
        abi: riskOracleAbi,
        functionName: "isFresh",
        args: [this.vault()],
      })) as boolean;
    } catch {
      return false;
    }
  }

  /**
   * Executes the approved protective rotation.
   *
   * `minDefensiveOut` is computed from the Guardian's slippage estimate plus a
   * safety margin, so a venue that has moved against us reverts rather than
   * filling at a worse price than the user was shown.
   */
  async executeProtection(input: {
    amountAssetUnits: bigint;
    action: Action;
    reasoning: string;
    maxSlippageBps: number;
  }): Promise<ExecuteResult | null> {
    if (!this.canSign || !this.walletClient || !this.publicClient || !this.account) return null;

    const state = await this.readVaultState();
    if (!state) return null;

    // Execution consumes a nonce too, so it shares the write queue with
    // anchoring — otherwise a rotation racing an anchor loses the same way.
    return this.serialize(async () => {
    try {
      // Nominal 1:1 conversion between asset and defensive units, less the
      // tolerated slippage.
      let nominalOut = input.amountAssetUnits;
      if (state.defensiveDecimals > state.assetDecimals) {
        nominalOut *= 10n ** BigInt(state.defensiveDecimals - state.assetDecimals);
      } else if (state.defensiveDecimals < state.assetDecimals) {
        nominalOut /= 10n ** BigInt(state.assetDecimals - state.defensiveDecimals);
      }
      const minOut =
        (nominalOut * BigInt(10_000 - Math.min(9_999, input.maxSlippageBps))) / 10_000n;

      const hash = await this.walletClient!.writeContract({
        address: config.chain.contracts.protectionExecutor as Address,
        abi: protectionExecutorAbi,
        functionName: "executeProtection",
        args: [
          {
            position: this.vault(),
            assetsIn: input.amountAssetUnits,
            minDefensiveOut: minOut,
            router: config.chain.contracts.dexRouter as Address,
            action: ACTION_ENUM[input.action],
            reasoningHash: keccak256(toHex(input.reasoning)),
          },
        ],
        account: this.account!,
        chain: this.walletClient!.chain,
      });

      const receipt = await this.publicClient!.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });
      if (receipt.status !== "success") {
        logger.error({ hash }, "protection transaction reverted");
        return null;
      }

      logger.info({ hash, amount: input.amountAssetUnits.toString() }, "protection executed");
      // The rotation just changed the balances this cache describes.
      this.invalidateVaultState();
      return { txHash: hash };
    } catch (err) {
      logger.error({ err: describeChainError(err) }, "protection execution failed");
      return null;
    }
    });
  }

  /** Health snapshot surfaced on /api/health. */
  async health(): Promise<{
    available: boolean;
    canSign: boolean;
    chainId?: number;
    blockNumber?: string;
    guardian?: string;
    error?: string;
  }> {
    if (!this.available || !this.publicClient) {
      return { available: false, canSign: false };
    }
    try {
      const blockNumber = await this.publicClient.getBlockNumber();
      return {
        available: true,
        canSign: this.canSign,
        chainId: config.chain.chainId,
        blockNumber: blockNumber.toString(),
        guardian: this.guardianAddress ?? undefined,
      };
    } catch (err) {
      return {
        available: false,
        canSign: this.canSign,
        error: err instanceof Error ? err.message : "rpc unreachable",
      };
    }
  }
}

/**
 * Condenses a viem error into something readable.
 *
 * viem attaches the full request body, the ABI and a nested cause chain to
 * every failure, which pino then serialises in full — thousands of characters
 * that bury the one line that matters. This keeps the short message and the
 * node's own detail, and drops the rest.
 */
function describeChainError(err: unknown): { reason: string; detail?: string } {
  if (typeof err !== "object" || err === null) return { reason: String(err) };
  const e = err as { shortMessage?: string; details?: string; message?: string };
  const reason = (e.shortMessage ?? e.message ?? "chain call failed").split("\n")[0]!;
  return e.details ? { reason, detail: e.details } : { reason };
}

let instance: ChainService | null = null;

export function getChainService(): ChainService {
  if (!instance) instance = new ChainService();
  return instance;
}

export function setChainService(service: ChainService): void {
  instance = service;
}
