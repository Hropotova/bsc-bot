require('dotenv').config();
const axios = require('axios');

const api = axios.create({
    baseURL: 'https://deep-index.moralis.io/api/v2.2/',
    headers: {
        accept: 'application/json',
        'X-API-Key': process.env.MORALIS_API_KEY
    }
});

// Retrieve the full transaction history of a specified wallet address, including sends, receives, token.
const getWalletHistory = async (address, chain) => {
    try {
        let cursor = null;
        let allTransactions = [];

        while (true) {
            const url = `wallets/${address}/history?chain=${chain}&order=ASC${cursor ? `&cursor=${cursor}` : ''}`;
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
const getWalletTokenBalances = async (address, chain) => {
    try {
        const url = `wallets/${address}/tokens?chain=${chain}`;
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
const getTokenPrice = async (token, chain) => {
    try {
        const url = `erc20/${token}/price?chain=${chain}`;
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error(`Error fetching price for token ${token}:`, error.message);
        return null;
    }
};

// Get the pair stats by using pair address.
const getPairStats = async (txHash, chain) => {
    const url = `pairs/${txHash}/stats?chain=${chain}`;
    try {
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error(`Error fetching pair data ${txHash}:`, error.message);
        return null;
    }
};

module.exports = {
    getWalletHistory,
    getWalletTokenBalances,
    getActiveWalletChains,
    getTokenPrice,
    getPairStats,
};
