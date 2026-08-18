import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    // X Layer testnet. Chain id verified live against the RPC
    // (eth_chainId -> 0x7a0 = 1952); an older 195 appears in some docs and
    // will make Hardhat abort with a network mismatch.
    xlayerTestnet: {
      url: process.env.XLAYER_RPC_URL ?? "https://testrpc.xlayer.tech",
      chainId: Number(process.env.XLAYER_CHAIN_ID ?? 1952),
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    artifacts: "./artifacts",
  },
};

export default config;
