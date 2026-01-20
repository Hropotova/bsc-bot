require('dotenv').config();
const axios = require('axios');
const { logger } = require('../performanceLogger');

const THROUGHPUT_CU_PER_SEC = 2000;
const MAX_REQUESTS_PER_SEC = 50;

const COST = {
    swaps: 20,
    history: 30,
    balances: 20,
    tokenPrice: 20,
    tokenPricesBatch: 50,
    activeChainsBase: 50,
    activeChainsPerChain: 50,
};

const swapsCache = new Map();
const historyCache = new Map();
const balancesCache = new Map();
const chainsCache = new Map();
const priceCache = new Map();

function clearMoralisCache() {
    const stats = {
        swaps: swapsCache.size,
        history: historyCache.size,
        balances: balancesCache.size,
        chains: chainsCache.size,
        price: priceCache.size
    };

    swapsCache.clear();
    historyCache.clear();
    balancesCache.clear();
    chainsCache.clear();
    priceCache.clear();

    logger.logInfo(`Moralis cache cleared: ${JSON.stringify(stats)}`);
}

class RateLimiter {
    constructor({ cuPerSec, reqPerSec }) {
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
            this.queue.push({ cost, fn, resolve, reject });
            this.processQueue();
        });
    }

    getQueueStatus() {
        return {
            queueLength: this.queue.length,
            availableCU: Math.round(this.availableCU),
            availableReq: Math.round(this.availableReq)
        };
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

const logRateLimitHeaders = (headers) => {
    const remaining = headers['x-rate-limit-remaining'];
    const cost = headers['x-rate-limit-cost'];
    if (remaining && parseInt(remaining) < 100) {
        logger.logWarning(`Moralis rate limit low: ${remaining} remaining, cost: ${cost}`);
    }
};

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
            logger.logWarning(`Moralis retry ${attempt + 1}/${maxRetries} in ${Math.round(wait)}ms (status=${status || 'network'})`);
            await new Promise(r => setTimeout(r, wait));
        }
    }
    throw new Error('Exceeded max retries');
};

const withFullRetry = async (fn, fnName, maxRetries = 2) => {
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const errMsg = err.response?.data?.message || err.message;

            if (attempt < maxRetries) {
                const wait = 2000 * (attempt + 1);
                logger.logWarning(`${fnName} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${errMsg}. Retrying in ${wait}ms...`);
                await new Promise(r => setTimeout(r, wait));
            } else {
                logger.logError(`${fnName} failed after ${maxRetries + 1} attempts: ${errMsg}`);
            }
        }
    }

    throw lastError;
};

// ============================================================
// BATCH TOKEN PRICES - до 100 токенів за запит!
// ============================================================

/**
 * Отримує ціни для багатьох токенів одним batch запитом
 * @param {string[]} tokenAddresses - масив адрес токенів
 * @param {string} chain - мережа (eth, base, bsc, etc.)
 * @returns {Map<string, object>} - Map з адресою як ключем
 */
const getTokenPricesBatch = async (tokenAddresses, chain, block = null) => {
    if (!tokenAddresses || tokenAddresses.length === 0) {
        return new Map();
    }

    const uncached = [];
    const results = new Map();

    for (const addr of tokenAddresses) {
        const addrLower = addr.toLowerCase();
        const key = `${addrLower}:${chain}:${block ?? ''}`; // IMPORTANT: ключ як у getTokenPrice()
        if (priceCache.has(key)) {
            results.set(addrLower, priceCache.get(key));
        } else {
            uncached.push(addrLower);
        }
    }

    if (uncached.length === 0) {
        logger.logInfo(`Moralis batch prices: all ${tokenAddresses.length} tokens from cache`);
        return results;
    }

    const BATCH_SIZE = 100;
    const chunks = [];
    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        chunks.push(uncached.slice(i, i + BATCH_SIZE));
    }

    const timer = logger.startOperation(
        'Moralis',
        'batchGetPrices',
        `${uncached.length} tokens in ${chunks.length} batch(es)${block != null ? ` @block=${block}` : ''}`
    );

    for (const chunk of chunks) {
        try {
            const body = {
                tokens: chunk.map(token_address => (
                    block != null
                        ? { token_address, to_block: Number(block) }
                        : { token_address }
                ))
            };

            const resp = await rateLimiter.schedule(COST.tokenPricesBatch, () =>
                fetchWithRetry(() => api.post(`erc20/prices?chain=${chain}`, body))
            );

            const prices = resp.data || [];

            for (const priceData of prices) {
                const addr = priceData.tokenAddress?.toLowerCase();
                if (addr) {
                    const cacheKey = `${addr}:${chain}:${block ?? ''}`;
                    priceCache.set(cacheKey, priceData);
                    results.set(addr, priceData);
                }
            }

            // якщо Moralis не повернув ціну для деяких адрес — кешуємо null
            for (const addr of chunk) {
                if (!results.has(addr)) {
                    const cacheKey = `${addr}:${chain}:${block ?? ''}`;
                    priceCache.set(cacheKey, null);
                    results.set(addr, null);
                }
            }

            logger.logInfo(`  └─ Batch chunk: ${chunk.length} tokens, ${prices.length} prices found`);
        } catch (error) {
            logger.logError(`Moralis batch prices failed: ${error.response?.data?.message || error.message}`);
            for (const addr of chunk) {
                const cacheKey = `${addr}:${chain}:${block ?? ''}`;
                priceCache.set(cacheKey, null);
                results.set(addr, null);
            }
        }
    }

    logger.endOperation(timer);
    logger.logInfo(`Moralis batch prices complete: ${results.size} tokens processed`);

    return results;
};


/**
 * Prefetch цін токенів для подальшого використання
 */
const prefetchTokenPrices = async (tokenAddresses, chain) => {
    if (!tokenAddresses || tokenAddresses.length === 0) return;

    const unique = [...new Set(tokenAddresses.map(a => a.toLowerCase()))];
    logger.logInfo(`Moralis price prefetch: ${unique.length} unique tokens`);

    await getTokenPricesBatch(unique, chain);
};

// ============================================================
// EXISTING FUNCTIONS
// ============================================================

const getWalletTokenSwaps = async (address, chain) => {
    const key = `${address}:${chain}`;
    if (swapsCache.has(key)) {
        logger.logInfo(`Moralis swaps CACHE HIT: ${address.slice(0, 10)}...`);
        return swapsCache.get(key);
    }

    const timer = logger.startOperation('Moralis', 'getWalletTokenSwaps', `${chain}:${address.slice(0, 10)}...`);

    try {
        const result = await withFullRetry(async () => {
            let cursor = null, allSwaps = [], pageCount = 0;

            while (true) {
                pageCount++;
                const url = `wallets/${address}/swaps?chain=${chain}&order=ASC${cursor ? `&cursor=${cursor}` : ''}`;
                const resp = await rateLimiter.schedule(COST.swaps, () =>
                    fetchWithRetry(() => api.get(url))
                );
                const swaps = resp.data.result || [];
                allSwaps.push(...swaps);
                if (!resp.data.cursor || swaps.length < 100) break;
                cursor = resp.data.cursor;
            }

            return { allSwaps, pageCount };
        }, 'getWalletTokenSwaps');

        swapsCache.set(key, result.allSwaps);
        logger.endOperation(timer);
        logger.logInfo(`  └─ ${result.allSwaps.length} swaps in ${result.pageCount} pages`);
        return result.allSwaps;
    } catch (err) {
        logger.endOperation(timer);
        logger.logError(`Moralis swaps failed: ${err.response?.data?.message || err.message}`);
        return [];
    }
};

const getWalletHistory = async (address, chain, fromBlock = null, toBlock = null) => {
    const legacyCall = (fromBlock == null && toBlock == null);
    const key = legacyCall
        ? `${address}:${chain}`
        : `${address}:${chain}:${fromBlock ?? ''}:${toBlock ?? ''}`;

    if (historyCache.has(key)) {
        logger.logInfo(`Moralis history CACHE HIT: ${address.slice(0, 10)}...`);
        return historyCache.get(key);
    }

    const blockInfo = legacyCall ? '' : ` blocks ${fromBlock}-${toBlock}`;
    const timer = logger.startOperation('Moralis', 'getWalletHistory', `${chain}:${address.slice(0, 10)}...${blockInfo}`);

    try {
        const result = await withFullRetry(async () => {
            let cursor = null, allTx = [], total = 0, pageCount = 0;

            while (true) {
                pageCount++;
                const base = `wallets/${address}/history?chain=${chain}&order=ASC`;
                const range =
                    (fromBlock != null ? `&from_block=${fromBlock}` : '') +
                    (toBlock != null ? `&to_block=${toBlock}` : '');
                const url = `${base}${range}${cursor ? `&cursor=${cursor}` : ''}`;
                const resp = await rateLimiter.schedule(COST.history, () =>
                    fetchWithRetry(() => api.get(url))
                );

                const txs = resp.data.result || [];
                total += txs.length;

                if (total > +process.env.MORALIS_TRANSACTIONS_COUNT) {
                    return { allTx: 'TRANSACTIONS_COUNT_LIMIT', pageCount, limitExceeded: true };
                }

                allTx.push(...txs);
                if (!resp.data.cursor || txs.length < 100) break;
                cursor = resp.data.cursor;
            }

            return { allTx, pageCount, limitExceeded: false };
        }, 'getWalletHistory');

        if (result.limitExceeded) {
            logger.endOperation(timer);
            logger.logWarning(`History limit exceeded: > ${process.env.MORALIS_TRANSACTIONS_COUNT}`);
            historyCache.set(key, 'TRANSACTIONS_COUNT_LIMIT');
            return 'TRANSACTIONS_COUNT_LIMIT';
        }

        historyCache.set(key, result.allTx);
        logger.endOperation(timer);
        logger.logInfo(`  └─ ${result.allTx.length} transactions in ${result.pageCount} pages`);
        return result.allTx;
    } catch (err) {
        logger.endOperation(timer);
        logger.logError(`Moralis history failed: ${err.response?.data?.message || err.message}`);
        return [];
    }
};

const getWalletTokenBalances = async (address, chain) => {
    const key = `${address}:${chain}`;
    if (balancesCache.has(key)) {
        logger.logInfo(`Moralis balances CACHE HIT: ${address.slice(0, 10)}...`);
        return balancesCache.get(key);
    }

    const timer = logger.startOperation('Moralis', 'getWalletTokenBalances', `${chain}:${address.slice(0, 10)}...`);

    try {
        const resp = await rateLimiter.schedule(COST.balances, () =>
            fetchWithRetry(() => api.get(`wallets/${address}/tokens?chain=${chain}`))
        );
        const result = resp.data.result || [];
        balancesCache.set(key, result);

        logger.endOperation(timer);
        logger.logInfo(`  └─ ${result.length} token balances`);
        return result;
    } catch (err) {
        logger.endOperation(timer);
        logger.logError(`Moralis balances failed: ${err.response?.data?.message || err.message}`);
        return [];
    }
};

const getActiveWalletChains = async (address) => {
    const key = address;
    if (chainsCache.has(key)) {
        logger.logInfo(`Moralis chains CACHE HIT: ${address.slice(0, 10)}...`);
        return chainsCache.get(key);
    }

    const timer = logger.startOperation('Moralis', 'getActiveWalletChains', address.slice(0, 10) + '...');

    try {
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

        logger.endOperation(timer);
        logger.logInfo(`  └─ Active chains: ${active.join(', ') || 'none'}`);
        return active;
    } catch (err) {
        logger.endOperation(timer);
        logger.logError(`Moralis chains failed: ${err.response?.data?.message || err.message}`);
        return [];
    }
};

/**
 * Single token price - спочатку перевіряє кеш (може бути від batch prefetch)
 */
const getTokenPrice = async (token, chain, block) => {
    const key = `${token.toLowerCase()}:${chain}:${block || ''}`;
    if (priceCache.has(key)) {
        return priceCache.get(key);
    }

    const timer = logger.startOperation('Moralis', 'getTokenPrice', `${chain}:${token.slice(0, 10)}...`);

    try {
        const url = `erc20/${token}/price?chain=${chain}${block ? `&to_block=${block}` : ''}`;
        const resp = await rateLimiter.schedule(COST.tokenPrice, () =>
            fetchWithRetry(() => api.get(url))
        );
        priceCache.set(key, resp.data);

        logger.endOperation(timer);
        return resp.data;
    } catch (err) {
        logger.endOperation(timer);
        logger.logError(`Moralis price failed for ${token}: ${err.response?.data?.message || err.message}`);
        priceCache.set(key, null);
        return null;
    }
};

module.exports = {
    getWalletTokenSwaps,
    getWalletHistory,
    getWalletTokenBalances,
    getActiveWalletChains,
    getTokenPrice,
    getTokenPricesBatch,
    prefetchTokenPrices,
    clearMoralisCache,
};
