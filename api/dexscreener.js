require('dotenv').config();
const axios = require('axios');
const { logger } = require('../performanceLogger');

const dexSingleCache = new Map();
const dexBatchCache = new Map();

function clearDexCache() {
    const stats = {
        single: dexSingleCache.size,
        batch: dexBatchCache.size
    };
    dexSingleCache.clear();
    dexBatchCache.clear();
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
            const { fn, resolve, reject } = this.queue.shift();
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
                this.queue.push({ fn, resolve, reject });
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

const getDexscreenerTokenPrice = async (tokenAddress, chainId) => {
    const key = `${chainId}:${tokenAddress}`;
    if (dexSingleCache.has(key)) {
        // Не логуємо cache hit для dex - їх багато
        return dexSingleCache.get(key);
    }

    const timer = logger.startOperation('Dexscreener', 'getTokenPrice', `${chainId}:${tokenAddress.slice(0, 10)}...`);
    const url = `latest/dex/tokens/${tokenAddress}`;

    try {
        const response = await defaultLimiter.schedule(() =>
            fetchWithRetry(() => api.get(url))
        );

        logger.endOperation(timer);

        if (response?.data?.pairs?.length > 0) {
            const pairs = Array.isArray(response?.data?.pairs)
                ? response.data.pairs
                : Array.isArray(response?.data)
                    ? response.data
                    : [];

            if (!pairs.length) {
                dexSingleCache.set(key, null);
                return null;
            }

            const toUsd = p => Number(p?.liquidity?.usd) || 0;
            const toTs = p => Number(p?.pairCreatedAt) || 0;

            const topPair = pairs.reduce((best, p) => {
                if (!best) return p;
                const bu = toUsd(best), pu = toUsd(p);
                if (pu !== bu) return pu > bu ? p : best;
                return toTs(p) > toTs(best) ? p : best;
            }, null);

            dexSingleCache.set(key, topPair);
            logger.logInfo(`  └─ Found ${pairs.length} pairs, top liquidity: $${toUsd(topPair).toLocaleString()}`);
            return topPair;
        } else {
            const result = response?.data?.pairs?.[0] || null;
            dexSingleCache.set(key, result);
            return result;
        }

    } catch (error) {
        logger.endOperation(timer);
        logger.logError(`Dexscreener failed for ${tokenAddress}: ${error.response?.data || error.message}`);
        dexSingleCache.set(key, null);
        return null;
    }
};

module.exports = {
    getDexscreenerTokenPrice,
    clearDexCache,
};
