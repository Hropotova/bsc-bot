require('dotenv').config();
const axios = require('axios');

const THROUGHPUT_CU_PER_SEC = 1500; // Total available CUs per second
const MAX_REQUESTS_PER_SEC = 50; // Global request limit

// Cost in CUs for each endpoint
const COST = {
    swaps: 20,               // /wallets/:address/swaps
    history: 30,             // /wallets/{address}/history
    balances: 20,            // /wallets/{address}/tokens
    tokenPrice: 20,          // /erc20/{address}/price
    activeChainsBase: 50,    // Base cost for /wallets/{address}/chains
    activeChainsPerChain: 50 // +50 CUs for each chain passed as a parameter
};

// Simple implementation of a token bucket rate limiter
class RateLimiter {
    constructor({cuPerSec, reqPerSec}) {
        this.cuPerSec = cuPerSec;
        this.reqPerSec = reqPerSec;

        this.availableCU = cuPerSec;
        this.availableReq = reqPerSec;

        this.queue = [];

        this.refillInterval = setInterval(() => this.refill(), 100);
    }

    refill() {
        this.availableCU = Math.min(this.cuPerSec, this.availableCU + this.cuPerSec / 10);
        this.availableReq = Math.min(this.reqPerSec, this.availableReq + this.reqPerSec / 10);
        this.processQueue();
    }

    processQueue() {
        while (this.queue.length) {
            const item = this.queue[0];
            if (this.availableReq >= 1 && this.availableCU >= item.cost) {
                this.availableReq -= 1;
                this.availableCU -= item.cost;
                this.queue.shift();
                item
                    .fn()
                    .then(item.resolve)
                    .catch(item.reject);
            } else {
                break;
            }
        }
    }

    schedule(cost, fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({cost, fn, resolve, reject});
            this.processQueue();
        });
    }
}

const rateLimiter = new RateLimiter({
    cuPerSec: THROUGHPUT_CU_PER_SEC,
    reqPerSec: MAX_REQUESTS_PER_SEC,
});

const api = axios.create({
    baseURL: 'https://deep-index.moralis.io/api/v2.2/',
    headers: {
        accept: 'application/json',
        'X-API-Key': process.env.MORALIS_API_KEY,
    },
});

// Logging rate limit headers for diagnostics
const logRateLimitHeaders = (headers) => {
    const keys = [
        'x-rate-limit-limit',
        'x-rate-limit-remaining',
        'x-rate-limit-reset',
        'x-rate-limit-cost',
    ];
    keys.forEach(k => {
        if (headers[k]) {
            console.debug(`[RateLimit] ${k}: ${headers[k]}`);
        }
    });
};

// Fetch with retries using exponential backoff
const fetchWithRetry = async (fn, maxRetries = 5) => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const resp = await fn();
            logRateLimitHeaders(resp.headers || {});
            return resp;
        } catch (err) {
            const status = err.response?.status;
            const isRetryable =
                status === 429 ||
                err.code === 'ECONNRESET' ||
                err.code === 'ETIMEDOUT' ||
                !err.response;
            if (attempt === maxRetries || !isRetryable) {
                throw err;
            }
            const backoff = 200 * Math.pow(2, attempt);
            const jitter = Math.random() * 100;
            const wait = backoff + jitter;
            console.warn(
                `Request failed (status=${status || 'network'}) attempt ${
                    attempt + 1
                }, retrying in ${Math.round(wait)}ms`
            );
            await new Promise(r => setTimeout(r, wait));
        }
    }
};

// Get all swap related transactions (buy, sell).
const getWalletTokenSwaps = async (address, chain) => {
    try {
        console.log(`Moralis: Fetching swaps for ${address} for chain ${chain}`);
        let cursor = null;
        let allSwaps = [];

        while (true) {
            const url = `wallets/${address}/swaps?chain=${chain}&order=ASC${cursor ? `&cursor=${cursor}` : ''}`;

            const response = await rateLimiter.schedule(COST.swaps, () =>
                fetchWithRetry(() => api.get(url))
            );
            const data = response.data;
            const swaps = data.result || [];

            allSwaps.push(...swaps);

            if (!data.cursor || swaps.length < 100) break;
            cursor = data.cursor;
        }

        console.log(`Moralis: Fetched ${allSwaps.length} swaps for ${address} for chain ${chain}`);
        return allSwaps;
    } catch (error) {
        console.error(`Error fetching swaps for ${address}:`, error.response?.data?.message);
        return [];
    }
};

// Retrieve the full transaction history of a specified wallet address.
const getWalletHistory = async (address, chain) => {
    try {
        console.log(`Moralis: Fetching transactions history for ${address} for chain ${chain}`);
        let cursor = null;
        const allTransactions = [];

        while (true) {
            const url = `wallets/${address}/history?chain=${chain}&order=ASC${cursor ? `&cursor=${cursor}` : ''}`;

            const response = await rateLimiter.schedule(COST.history, () =>
                fetchWithRetry(() => api.get(url))
            );
            const data = response.data;
            const transactions = data.result || [];

            allTransactions.push(...transactions);

            if (!data.cursor || transactions.length < 100) {
                break;
            }

            cursor = data.cursor;
        }

        console.log(`Moralis: Fetched ${allTransactions.length} transactions history for ${address} for chain ${chain}`);
        return allTransactions;
    } catch (error) {
        console.error(`Error fetching history for ${address}:`, error.response?.data?.message || error.message);
        return [];
    }
};

// Get token balances for a specific wallet address.
const getWalletTokenBalances = async (address, chain) => {
    try {
        console.log(`Moralis: Fetching token balances for ${address} for chain ${chain}`);
        const url = `wallets/${address}/tokens?chain=${chain}`;

        const response = await rateLimiter.schedule(COST.balances, () =>
            fetchWithRetry(() => api.get(url))
        );

        console.log(`Moralis: Fetched token balances for ${address} for chain ${chain}`);
        return response.data.result || [];
    } catch (error) {
        console.error(`Error fetching balance for ${address}:`, error.response?.data?.message);
        return [];
    }
};

// Get the active chains for a wallet address.
const getActiveWalletChains = async (address) => {
    try {
        console.log(`Moralis: Fetching active chains for ${address}`);
        const chains = [
            'eth',
            'bsc',
            'arbitrum',
            'base',
            'avalanche',
        ];

        const params = chains.map((chain, index) => `chains[${index}]=${chain}`).join('&');
        const url = `wallets/${address}/chains?${params}`;

        const dynamicCost = COST.activeChainsBase + chains.length * COST.activeChainsPerChain;

        const response = await rateLimiter.schedule(dynamicCost, () =>
            fetchWithRetry(() => api.get(url))
        );
        const activeChains = response.data.active_chains || [];

        console.log(`Moralis: Fetched active chains for ${address}`);
        return activeChains.filter(chain => chain?.first_transaction !== null || chain?.last_transaction !== null).map(chain => chain?.chain);
    } catch (error) {
        console.error(`Error fetching active chains for ${address}:`, error.response?.data?.message);
        return [];
    }
};

// Get the token price denominated in the blockchain's native token and USD.
const getTokenPrice = async (token, chain, block) => {
    try {
        console.log(`Moralis: Fetching price for token ${token} for chain ${chain}`);
        const url = `erc20/${token}/price?chain=${chain}${block ? `&to_block=${block}` : ''}`;

        const response = await rateLimiter.schedule(COST.tokenPrice, () =>
            fetchWithRetry(() => api.get(url))
        );

        console.log(`Moralis: Fetched price for token ${token} for chain ${chain}`);
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
