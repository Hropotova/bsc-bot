require('dotenv').config();
const axios = require('axios');
const {logger} = require('../performanceLogger');

const dexSingleCache = new Map();

function clearDexCache() {
    const stats = {
        single: dexSingleCache.size,
    };
    dexSingleCache.clear();
    logger.logInfo(`Dexscreener cache cleared: ${JSON.stringify(stats)}`);
}

class SimpleRateLimiter {
    constructor(maxPerSecond) {
        this.maxPerSecond = maxPerSecond;
        this.tokens = maxPerSecond;
        this.queue = [];

        setInterval(() => {
            this.tokens = this.maxPerSecond;
            this._processQueue();
        }, 1000);
    }

    _processQueue() {
        while (this.tokens > 0 && this.queue.length) {
            const {fn, resolve, reject} = this.queue.shift();
            this.tokens--;
            fn().then(resolve).catch(reject);
        }
    }

    schedule(fn) {
        return new Promise((resolve, reject) => {
            if (this.tokens > 0) {
                this.tokens--;
                fn().then(resolve).catch(reject);
            } else {
                this.queue.push({fn, resolve, reject});
            }
        });
    }

    getQueueStatus() {
        return {
            queueLength: this.queue.length,
            availableTokens: this.tokens
        };
    }
}

const defaultLimiter = new SimpleRateLimiter(5);

const api = axios.create({
    baseURL: process.env.DEXSCREENER_BASE_URL || 'https://api.dexscreener.com/',
    headers: {
        accept: '*/*',
    },
});

const logHeaders = (headers) => {
    if (!headers) return;
    const remaining = headers['x-ratelimit-remaining'];
    if (remaining && parseInt(remaining) < 10) {
        logger.logWarning(`Dexscreener rate limit low: ${remaining} remaining`);
    }
};

const fetchWithRetry = async (fn, maxRetries = 5) => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const resp = await fn();
            logHeaders(resp.headers);
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

            const retryAfter = err.response?.headers?.['retry-after'];
            if (retryAfter) {
                const serverWait = parseFloat(retryAfter) * 1000;
                logger.logWarning(`Dexscreener retry-after: ${retryAfter}s`);
                await new Promise(r => setTimeout(r, serverWait + 100));
            } else {
                logger.logWarning(`Dexscreener retry ${attempt + 1}/${maxRetries} in ${Math.round(wait)}ms`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
    }
    throw new Error('Exceeded max retries');
};

/**
 * Вибирає найкращу пару для токена (найбільша ліквідність, потім найновіша)
 */
const selectBestPair = (pairs) => {
    if (!pairs || !pairs.length) return null;

    const toUsd = p => Number(p?.liquidity?.usd) || 0;
    const toTs = p => Number(p?.pairCreatedAt) || 0;

    return pairs.reduce((best, p) => {
        if (!best) return p;
        const bu = toUsd(best), pu = toUsd(p);
        if (pu !== bu) return pu > bu ? p : best;
        return toTs(p) > toTs(best) ? p : best;
    }, null);
};

/**
 * BATCH запит - до 30 токенів за раз
 * Значно швидше ніж окремі запити!
 *
 * @param {string[]} tokenAddresses - масив адрес токенів
 * @param {string} chainId - ID мережі (ethereum, base, etc.)
 * @returns {Map<string, object>} - Map з адресою як ключем і pair data як значенням
 */
const getDexscreenerTokenPricesBatch = async (tokenAddresses, chainId) => {
    if (!tokenAddresses || tokenAddresses.length === 0) {
        return new Map();
    }

    // Фільтруємо вже закешовані
    const uncached = [];
    const results = new Map();

    for (const addr of tokenAddresses) {
        const key = `${chainId}:${addr.toLowerCase()}`;
        if (dexSingleCache.has(key)) {
            results.set(addr.toLowerCase(), dexSingleCache.get(key));
        } else {
            uncached.push(addr);
        }
    }

    if (uncached.length === 0) {
        logger.logInfo(`Dexscreener batch: all ${tokenAddresses.length} tokens from cache`);
        return results;
    }

    // Розбиваємо на chunks по 30 (ліміт Dexscreener API)
    const BATCH_SIZE = 30;
    const chunks = [];
    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        chunks.push(uncached.slice(i, i + BATCH_SIZE));
    }

    const timer = logger.startOperation('Dexscreener', 'batchGetPrices',
        `${uncached.length} tokens in ${chunks.length} batch(es)`);

    for (const chunk of chunks) {
        const addressList = chunk.join(',');
        const url = `latest/dex/tokens/${addressList}`;

        try {
            const response = await defaultLimiter.schedule(() =>
                fetchWithRetry(() => api.get(url))
            );

            const pairs = response?.data?.pairs || [];

            // Групуємо pairs по baseToken.address
            const pairsByToken = new Map();
            for (const pair of pairs) {
                const baseAddr = pair?.baseToken?.address?.toLowerCase();
                if (!baseAddr) continue;

                if (!pairsByToken.has(baseAddr)) {
                    pairsByToken.set(baseAddr, []);
                }
                pairsByToken.get(baseAddr).push(pair);
            }

            // Для кожного токена вибираємо найкращу пару
            for (const addr of chunk) {
                const addrLower = addr.toLowerCase();
                const tokenPairs = pairsByToken.get(addrLower) || [];
                const bestPair = selectBestPair(tokenPairs);

                const cacheKey = `${chainId}:${addrLower}`;
                dexSingleCache.set(cacheKey, bestPair);
                results.set(addrLower, bestPair);
            }

            logger.logInfo(`  └─ Batch chunk: ${chunk.length} tokens, ${pairs.length} pairs found`);

        } catch (error) {
            logger.logError(`Dexscreener batch failed: ${error.message}`);
            // Кешуємо null для failed токенів
            for (const addr of chunk) {
                const cacheKey = `${chainId}:${addr.toLowerCase()}`;
                dexSingleCache.set(cacheKey, null);
                results.set(addr.toLowerCase(), null);
            }
        }
    }

    logger.endOperation(timer);
    logger.logInfo(`Dexscreener batch complete: ${results.size} tokens processed`);

    return results;
};

/**
 * Одиничний запит (для сумісності з існуючим кодом)
 * Спочатку перевіряє кеш - якщо був batch prefetch, поверне миттєво
 */
const getDexscreenerTokenPrice = async (tokenAddress, chainId) => {
    const key = `${chainId}:${tokenAddress.toLowerCase()}`;
    if (dexSingleCache.has(key)) {
        return dexSingleCache.get(key);
    }

    const timer = logger.startOperation('Dexscreener', 'getTokenPrice',
        `${chainId}:${tokenAddress.slice(0, 10)}...`);
    const url = `latest/dex/tokens/${tokenAddress}`;

    try {
        const response = await defaultLimiter.schedule(() =>
            fetchWithRetry(() => api.get(url))
        );

        logger.endOperation(timer);

        const pairs = response?.data?.pairs || [];
        const bestPair = selectBestPair(pairs);

        dexSingleCache.set(key, bestPair);

        if (pairs.length > 0) {
            const toUsd = p => Number(p?.liquidity?.usd) || 0;
            logger.logInfo(`  └─ Found ${pairs.length} pairs, top liquidity: $${toUsd(bestPair).toLocaleString()}`);
        }

        return bestPair;

    } catch (error) {
        logger.endOperation(timer);
        logger.logError(`Dexscreener failed for ${tokenAddress}: ${error.response?.data || error.message}`);
        dexSingleCache.set(key, null);
        return null;
    }
};

/**
 * Prefetch токенів для подальшого використання
 * Викликати на початку обробки, щоб закешувати все заздалегідь
 */
const prefetchDexscreenerPrices = async (tokenAddresses, chainId) => {
    if (!tokenAddresses || tokenAddresses.length === 0) return;

    const unique = [...new Set(tokenAddresses.map(a => a.toLowerCase()))];
    logger.logInfo(`Dexscreener prefetch: ${unique.length} unique tokens`);

    await getDexscreenerTokenPricesBatch(unique, chainId);
};

module.exports = {
    getDexscreenerTokenPrice,
    getDexscreenerTokenPricesBatch,
    prefetchDexscreenerPrices,
    clearDexCache,
};
