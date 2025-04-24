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
const getWalletTokenSwaps = async (address) => {
    try {
        let cursor = null;
        let allSwaps = [];

        while (true) {
            const url = `wallets/${address}/swaps?chain=${process.env.CHAIN}&order=ASC${cursor ? `&cursor=${cursor}` : ''}`;
            const response = await api.get(url);
            const data = response.data;
            const swaps = data.result || [];

            allSwaps.push(...swaps);

            if (!data.cursor || swaps.length < 100) break;
            cursor = data.cursor;
        }

        return allSwaps;
    } catch (error) {
        console.error(`Error fetching swaps for ${address}:`, error.message);
        return [];
    }
};

// Retrieve the full transaction history of a specified wallet address, including sends, receives, token.
const getWalletHistory = async (address) => {
    try {
        let cursor = null;
        let allTransactions = [];

        while (true) {
            const url = `wallets/${address}/history?chain=${process.env.CHAIN}&order=ASC${cursor ? `&cursor=${cursor}` : ''}`;
            const response = await api.get(url);
            const data = response.data;
            const transactions = data.result || [];

            allTransactions.push(...transactions);

            if (!data.cursor || transactions.length < 100) break;
            cursor = data.cursor;
        }

        return allTransactions;
    } catch (error) {
        console.error(`Error fetching swaps for ${address}:`, error.message);
        return [];
    }
};

// Get token balances for a specific wallet address and their token prices in USD.
const getWalletTokenBalances = async (address) => {
    try {
        const url = `wallets/${address}/tokens?chain=${process.env.CHAIN}`;
        const response = await api.get(url);

        return response.data.result || [];
    } catch (error) {
        console.error(`Error fetching balance for ${address}:`, error.message);
        return [];
    }
};

// Get the active chains for a wallet address.
const getActiveWalletChains = async (address, chains = ['eth', 'bsc', 'base']) => {
    try {
        const params = chains.map((chain, index) => `chains[${index}]=${chain}`).join('&');
        const url = `wallets/${address}/chains?${params}`;
        const response = await api.get(url);
        const activeChains = response.data.active_chains || [];

        return activeChains.filter(chain => chain?.first_transaction !== null || chain?.last_transaction !== null).map(chain => chain?.chain);
    } catch (error) {
        console.error(`Error fetching active chains for ${address}:`, error.message);
        return [];
    }
};

// Get the token price denominated in the blockchain's native token and USD.
const getTokenPrice = async (token) => {
    try {
        const url = `erc20/${token}/price?chain=${process.env.CHAIN}`;
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error(`Error fetching price for token ${token}:`, error.message);
        return null;
    }
};

// Get the contents of a transaction by the given transaction hash.
const getTransaction = async (hash) => {
    const url = `transaction/${hash}?chain=${process.env.CHAIN}`;
    try {
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error(`Error fetching transaction data ${hash}:`, error.message);
        return null;
    }
};

// Get the pair stats by using pair address.
const getPairStats = async (txHash) => {
    const url = `pairs/${txHash}/stats?chain=${process.env.CHAIN}`;
    try {
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error(`Failed to ge ${txHash}:`, error.message);
        return null;
    }
};
module.exports = {
    getWalletHistory,
    getWalletTokenSwaps,
    getWalletTokenBalances,
    getActiveWalletChains,
    getTokenPrice,
    getTransaction,
    getPairStats,
};
