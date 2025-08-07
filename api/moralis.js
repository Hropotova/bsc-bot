require('dotenv').config();
const axios = require('axios');

const THROUGHPUT_CU_PER_SEC = 1500; // Total available CUs per second
const MAX_REQUESTS_PER_SEC = 50;    // Global request limit

// Cost in CUs for each endpoint
const COST = {
    swaps: 20, // /wallets/:address/swaps
    history: 30, // /wallets/{address}/history
    balances: 20, // /wallets/{address}/tokens
    tokenPrice: 20, // /erc20/{address}/price
    activeChainsBase: 50, // Base cost for /wallets/{address}/chains
    activeChainsPerChain: 50, // +50 CUs per chain param
};

// In-memory caches for each Moralis request
const swapsCache = new Map();
const historyCache = new Map();
const balancesCache = new Map();
const chainsCache = new Map();
const priceCache = new Map();

// Function to clear all caches between processing different addresses
function clearMoralisCache() {
    swapsCache.clear();
    historyCache.clear();
    balancesCache.clear();
    chainsCache.clear();
    priceCache.clear();
}

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
                item.fn().then(item.resolve).catch(item.reject);
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
    [
        'x-rate-limit-limit',
        'x-rate-limit-remaining',
        'x-rate-limit-reset',
        'x-rate-limit-cost',
    ].forEach(k => {
        if (headers[k]) console.debug(`[RateLimit] ${k}: ${headers[k]}`);
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
            if (attempt === maxRetries || !isRetryable) throw err;
            const backoff = 200 * Math.pow(2, attempt);
            const jitter = Math.random() * 100;
            const wait = backoff + jitter;
            console.warn(`Moralis request failed (status=${status || 'network'}) attempt ${attempt + 1}, retrying in ${Math.round(wait)}ms`);
            await new Promise(r => setTimeout(r, wait));
        }
    }
    throw new Error('Exceeded max retries');
};

// Get all swap related transactions (buy, sell).
const getWalletTokenSwaps = async (address, chain) => {
    const key = `${address}:${chain}`;
    if (swapsCache.has(key)) {
        console.debug(`Cache hit: getWalletTokenSwaps(${key})`);
        return swapsCache.get(key);
    }
    try {
        console.debug(`Moralis: Fetching swaps for ${address} on ${chain}`);
        let cursor = null, allSwaps = [];
        while (true) {
            const url = `wallets/${address}/swaps?chain=${chain}&order=ASC${cursor ? `&cursor=${cursor}` : ''}`;
            const resp = await rateLimiter.schedule(COST.swaps, () =>
                fetchWithRetry(() => api.get(url))
            );
            const swaps = resp.data.result || [];
            allSwaps.push(...swaps);
            if (!resp.data.cursor || swaps.length < 100) break;
            cursor = resp.data.cursor;
        }
        console.debug(`Moralis: Fetched ${allSwaps.length} swaps for ${address} for chain ${chain}`);
        swapsCache.set(key, allSwaps);
        return allSwaps;
    } catch (err) {
        console.error(`Error fetching swaps for ${address}:`, err.response?.data?.message || err.message);
        return [];
    }
};

// Retrieve the full transaction history of a specified wallet address.
const getWalletHistory = async (address, chain) => {
    const key = `${address}:${chain}`;
    if (historyCache.has(key)) {
        console.debug(`Cache hit: getWalletHistory(${key})`);
        return historyCache.get(key);
    }
    try {
        console.debug(`Moralis: Fetching transactions history for ${address} for chain ${chain}`);
        let cursor = null, allTx = [], total = 0;
        while (true) {
            const url = `wallets/${address}/history?chain=${chain}&order=ASC${cursor ? `&cursor=${cursor}` : ''}`;
            const resp = await rateLimiter.schedule(COST.history, () =>
                fetchWithRetry(() => api.get(url))
            );
            const txs = resp.data.result || [];
            total += txs.length;
            if (total > +process.env.TRANSACTIONS_COUNT) {
                console.debug(`Moralis: Retrieved ${total} txs (requested max ${process.env.TRANSACTIONS_COUNT})`);
                historyCache.set(key, 'TRANSACTIONS_COUNT_LIMIT');
                return 'TRANSACTIONS_COUNT_LIMIT';
            }
            allTx.push(...txs);
            if (!resp.data.cursor || txs.length < 100) break;
            cursor = resp.data.cursor;
        }
        console.debug(`Moralis: Fetched ${allTx.length} transactions history for ${address} for chain ${chain}`);
        historyCache.set(key, allTx);
        return allTx;
    } catch (err) {
        console.error(`Error fetching history for ${address}:`, err.response?.data?.message || err.message);
        return [];
    }
};

// Get token balances for a specific wallet address.
const getWalletTokenBalances = async (address, chain) => {
    const key = `${address}:${chain}`;
    if (balancesCache.has(key)) {
        console.debug(`Cache hit: getWalletTokenBalances(${key})`);
        return balancesCache.get(key);
    }
    try {
        console.debug(`Moralis: Fetching balances for ${address} on ${chain}`);
        const resp = await rateLimiter.schedule(COST.balances, () =>
            fetchWithRetry(() => api.get(`wallets/${address}/tokens?chain=${chain}`))
        );
        const result = resp.data.result || [];
        balancesCache.set(key, result);
        return result;
    } catch (err) {
        console.error(`Error fetching balances for ${address}:`, err.response?.data?.message || err.message);
        return [];
    }
};

// Get the active chains for a wallet address.
const getActiveWalletChains = async (address) => {
    const key = address;
    if (chainsCache.has(key)) {
        console.debug(`Cache hit: getActiveWalletChains(${key})`);
        return chainsCache.get(key);
    }

    try {
        console.debug(`Moralis: Fetching active chains for ${address}`);
        const possible = ['eth', 'bsc', 'arbitrum', 'base', 'avalanche'];
        const params = possible.map((c, i) => `chains[${i}]=${c}`).join('&');
        const cost = COST.activeChainsBase + possible.length * COST.activeChainsPerChain;
        const resp = await rateLimiter.schedule(cost, () =>
            fetchWithRetry(() => api.get(`wallets/${address}/chains?${params}`))
        );
        const active = (resp.data.active_chains || [])
            .filter(c => c.first_transaction || c.last_transaction)
            .map(c => c.chain);
        chainsCache.set(key, active);
        console.debug(`Moralis: Fetched active chains for ${address}`);
        return active;
    } catch (err) {
        console.error(`Error fetching chains for ${address}:`, err.response?.data?.message || err.message);
        return [];
    }
};

// Get the token price denominated in the blockchain's native token and USD.
const getTokenPrice = async (token, chain, block) => {
    const key = `${token}:${chain}:${block || ''}`;
    if (priceCache.has(key)) {
        console.debug(`Cache hit:  getTokenPrice(${key})`);
        return priceCache.get(key);
    }
    try {
        console.debug(`Moralis: Fetching price for ${token} on ${chain}${block ? ` at block ${block}` : ''}`);
        const url = `erc20/${token}/price?chain=${chain}${block ? `&to_block=${block}` : ''}`;
        const resp = await rateLimiter.schedule(COST.tokenPrice, () =>
            fetchWithRetry(() => api.get(url))
        );
        priceCache.set(key, resp.data);
        console.debug(`Moralis: Fetched price for ${token} on ${chain}${block ? ` at block ${block}` : ''}`);

        return resp.data;
    } catch (err) {
        console.error(`Error fetching price for ${token}:`, err.response?.data?.message || err.message);
        return null;
    }
};

module.exports = {
    getWalletTokenSwaps,
    getWalletHistory,
    getWalletTokenBalances,
    getActiveWalletChains,
    getTokenPrice,
    clearMoralisCache,
};
