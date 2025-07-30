require('dotenv').config();
const axios = require('axios');

const api = axios.create({
    baseURL: 'https://deep-index.moralis.io/api/v2.2/',
    headers: {
        accept: 'application/json',
        'X-API-Key': process.env.MORALIS_API_KEY
    }
});

// Get all swap related transactions (buy, sell).
const getWalletTokenSwaps = async (address, chain) => {
    try {
        console.log(`Fetching swaps for ${address}`);
        let cursor = null;
        let allSwaps = [];

        while (true) {
            const url = `wallets/${address}/swaps?chain=${chain}&order=ASC${cursor ? `&cursor=${cursor}` : ''}`;
            const response = await api.get(url);
            const data = response.data;
            const swaps = data.result || [];

            allSwaps.push(...swaps);

            if (!data.cursor || swaps.length < 100) break;
            cursor = data.cursor;
        }
        console.log(`Fetched ${allSwaps.length} swaps for ${address}`);
        return allSwaps;
    } catch (error) {
        console.error(`Error fetching swaps for ${address}:`, error.response?.data?.message);
        return [];
    }
};

// Retrieve the full transaction history of a specified wallet address, including sends, receives, token.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const getWalletHistory = async (address, chain) => {
    try {
        console.log(`Fetching transactions history for ${address}`);
        let cursor = null;
        const allTransactions = [];

        while (true) {
            const url = `wallets/${address}/history?chain=${chain}&order=ASC${cursor ? `&cursor=${cursor}` : ''}`;
            const response = await api.get(url);
            const data = response.data;
            const transactions = data.result || [];

            allTransactions.push(...transactions);

            if (!data.cursor || transactions.length < 100) {
                break;
            }

            cursor = data.cursor;

            await delay(5000);
        }

        console.log(`Fetched ${allTransactions.length} transactions history for ${address}`);
        return allTransactions;
    } catch (error) {
        console.error(`Error fetching history for ${address}:`, error.response?.data?.message || error.message);
        return [];
    }
};


// Get token balances for a specific wallet address and their token prices in USD.
const getWalletTokenBalances = async (address, chain) => {
    try {
        console.log(`Fetching token balances for ${address}`);
        const url = `wallets/${address}/tokens?chain=${chain}`;
        const response = await api.get(url);
        console.log(`Fetched token balances for ${address}`);
        return response.data.result || [];
    } catch (error) {
        console.error(`Error fetching balance for ${address}:`, error.response?.data?.message);
        return [];
    }
};

// Get the active chains for a wallet address.
const getActiveWalletChains = async (address) => {
    try {
        console.log(`Fetching active chains for ${address}`);
        const chains = [
            'eth',
            'polygon',
            'bsc',
            'arbitrum',
            'base',
            'optimism',
            'linea',
            'avalanche',
            'fantom',
            'cronos',
            'gnosis',
            'chiliz',
            'moonbeam',
            'flow',
            'ronin',
            'lisk',
            'pulse',
        ];

        const params = chains.map((chain, index) => `chains[${index}]=${chain}`).join('&');
        const url = `wallets/${address}/chains?${params}`;
        const response = await api.get(url);

        const activeChains = response.data.active_chains || [];
        console.log(`Fetched active chains for ${address}`);
        return activeChains.filter(chain => chain?.first_transaction !== null || chain?.last_transaction !== null).map(chain => chain?.chain);
    } catch (error) {
        console.error(`Error fetching active chains for ${address}:`, error.response?.data?.message);
        return [];
    }
};

// Get the token price denominated in the blockchain's native token and USD.
const getTokenPrice = async (token, chain, block) => {
    try {
        console.log(`Fetching price for token ${token}`);
        const url = `erc20/${token}/price?chain=${chain}${block ? `&to_block=${block}` : ''}`;

        const response = await api.get(url);
        console.log(`Fetched price for token ${token}`);
        return response.data;
    } catch (error) {
        console.error(`Error fetching price for token ${token}:`, error.response?.data?.message);
        return null;
    }
};

module.exports = {
    getTokenPrice,
    getWalletHistory,
    getWalletTokenSwaps,
    getActiveWalletChains,
    getWalletTokenBalances,
};
