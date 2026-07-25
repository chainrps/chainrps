import "@nomicfoundation/hardhat-toolbox";

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
export default {
  solidity: "0.8.20",
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
  },
  paths: {
    sources: "./contracts/src",
    artifacts: "./contracts/abi",
  },
};
