require('dotenv').config();
const axios = require('axios');

const api = axios.create({
    baseURL: 'https://deep-index.moralis.io/api/v2.2/',
    headers: {
        accept: 'application/json',
        'X-API-Key': process.env.MORALIS_API_KEY
    }
});

const getWalletTokenSwaps = async (address) => {
    try {
        let cursor = null;
        let allSwaps = [];

        while (true) {
            const url = `wallets/${address}/swaps?chain=bsc&order=DESC${cursor ? `&cursor=${cursor}` : ''}`;
            const response = await api.get(url);
            const data = response.data;
            const swaps = data.result || [];

            allSwaps.push(...swaps);

            if (!data.cursor || swaps.length < 100) break;
            cursor = data.cursor;
        }

        return allSwaps;
    } catch (err) {
        console.log('err', err)

        console.error(`Error fetching swaps for ${address}:`, err.message);
        return [];
    }
};


const getWalletTokenBalances = async (address) => {
    try {
        const url = `wallets/${address}/tokens?chain=bsc`;
        const response = await api.get(url);
        return response.data.result || [];
    } catch (err) {
        console.error(`Error fetching balance for ${address}:`, err.message);
        return [];
    }
};

const getActiveWalletChains = async (address, chains = ['eth', 'bsc', 'base']) => {
    try {
        const params = chains.map((chain, index) => `chains[${index}]=${chain}`).join('&');
        const url = `wallets/${address}/chains?${params}`;
        const response = await api.get(url);
        const activeChains = response.data.active_chains || [];

        return activeChains.filter(chain => chain?.first_transaction !== null || chain?.last_transaction !== null).map(chain => chain?.chain);
    } catch (err) {
        console.error(`Error fetching active chains for ${address}:`, err.message);
        return [];
    }
};

const getTokenPrice = async (tokenAddress, chain = 'eth') => {
    try {
        const url = `erc20/${tokenAddress}/price?chain=${chain}&include=percent_change`;
        const response = await api.get(url);
        return response.data;
    } catch (err) {
        console.error(`Error fetching price for token ${tokenAddress} on ${chain}:`, err.message);
        return null;
    }
};

module.exports = {
    getWalletTokenSwaps,
    getWalletTokenBalances,
    getActiveWalletChains,
    getTokenPrice,
};
