const CONFIG = {
    rpcUrl: 'https://rpc-amoy.polygon.technology/',
    chainId: 80002,
    contractAddress: '0xYourContractAddress',
    
    backendUrl: 'http://localhost:8000',
    wsUrl: 'ws://localhost:8000',
    
    commitTimeout: 66,
    revealTimeout: 88,
    
    supportedTokens: [
        { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
        { symbol: 'USDT', name: 'Tether', decimals: 6 }
    ],
    
    tokenAddresses: {
        'USDC': '0x0000000000000000000000000000000000000000',
        'USDT': '0x0000000000000000000000000000000000000000'
    },
    
    enableModeB: true,
    defaultMode: 'A',
    
    defaultTheme: 'light',
    
    quickAmounts: [10, 50, 100, 500],
    
    officialDeveloper: '0x0000000000000000000000000000000000000000'
};
