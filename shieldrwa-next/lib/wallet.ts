/**
 * EIP-1193 wallet access.
 *
 * Deliberately dependency-free: the only wallet operations ShieldRWA needs are
 * `eth_requestAccounts` and `personal_sign`, both of which every injected
 * provider implements. No wallet library is pulled in for two RPC calls.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export class WalletError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

export function getProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  return window.ethereum ?? null;
}

export function hasWallet(): boolean {
  return getProvider() !== null;
}

export async function connectWallet(): Promise<string> {
  const provider = getProvider();
  if (!provider) {
    throw new WalletError(
      "No Ethereum wallet found. Install MetaMask or another EIP-1193 wallet to continue.",
    );
  }

  try {
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    const account = accounts?.[0];
    if (!account) throw new WalletError("Wallet returned no accounts.");
    return account;
  } catch (err) {
    const code = (err as { code?: number }).code;
    // 4001 is the EIP-1193 "user rejected request" code.
    if (code === 4001) throw new WalletError("Connection request was rejected.", 4001);
    throw new WalletError(
      err instanceof Error ? err.message : "Could not connect to the wallet.",
      code,
    );
  }
}

export async function getConnectedAccount(): Promise<string | null> {
  const provider = getProvider();
  if (!provider) return null;
  try {
    // `eth_accounts` does not prompt — it only reports an existing connection.
    const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
    return accounts?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function signMessage(address: string, message: string): Promise<string> {
  const provider = getProvider();
  if (!provider) throw new WalletError("No wallet available to sign with.");

  try {
    const signature = (await provider.request({
      method: "personal_sign",
      params: [message, address],
    })) as string;
    return signature;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 4001) throw new WalletError("Signature request was rejected.", 4001);
    throw new WalletError(
      err instanceof Error ? err.message : "Could not sign the message.",
      code,
    );
  }
}

export async function getChainId(): Promise<number | null> {
  const provider = getProvider();
  if (!provider) return null;
  try {
    const hex = (await provider.request({ method: "eth_chainId" })) as string;
    return Number.parseInt(hex, 16);
  } catch {
    return null;
  }
}

/**
 * Asks the wallet to switch to the target chain, adding it first if the wallet
 * has never seen it. Non-fatal: ShieldRWA reads chain state server-side, so a
 * refusal here does not block sign-in.
 */
export async function switchToChain(params: {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  currencySymbol?: string;
}): Promise<boolean> {
  const provider = getProvider();
  if (!provider) return false;
  const hexChainId = `0x${params.chainId.toString(16)}`;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexChainId }],
    });
    return true;
  } catch (err) {
    // 4902 = chain unknown to the wallet; add it, then the switch succeeds.
    if ((err as { code?: number }).code === 4902) {
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: hexChainId,
              chainName: params.chainName,
              rpcUrls: [params.rpcUrl],
              blockExplorerUrls: [params.explorerUrl],
              nativeCurrency: {
                name: params.currencySymbol ?? "OKB",
                symbol: params.currencySymbol ?? "OKB",
                decimals: 18,
              },
            },
          ],
        });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export function onAccountsChanged(handler: (accounts: string[]) => void): () => void {
  const provider = getProvider();
  if (!provider?.on || !provider.removeListener) return () => undefined;
  const wrapped = (...args: unknown[]) => handler((args[0] as string[]) ?? []);
  provider.on("accountsChanged", wrapped);
  return () => provider.removeListener?.("accountsChanged", wrapped);
}
