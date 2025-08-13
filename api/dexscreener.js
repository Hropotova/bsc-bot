require('dotenv').config();
const axios = require('axios');

// Simple in-memory cache for one-off and batch requests
const dexSingleCache = new Map();
const dexBatchCache = new Map();

// Function to clear the cache after processing each address
function clearDexCache() {
    dexSingleCache.clear();
    dexBatchCache.clear();
}

// Rate limiter for N calls per second
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
}

// free plan: ~5 requests per second for token-pairs endpoint
const defaultLimiter = new SimpleRateLimiter(5);

const api = axios.create({
    baseURL: process.env.DEXSCREENER_BASE_URL || 'https://api.dexscreener.com/',
    headers: {
        accept: '*/*',
    },
});

// Logging headers for diagnostics (if present)
const logHeaders = (headers) => {
    if (!headers) return;
    ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining'].forEach(h => {
        if (headers[h]) console.debug(`[Dexscreener Header] ${h}: ${headers[h]}`);
    });
};

// Fetch with retries and exponential backoff
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
                console.warn(`Server asked to retry after ${retryAfter}s; waiting ${Math.round(serverWait + 100)}ms`);
                await new Promise(r => setTimeout(r, serverWait + 100));
            } else {
                console.warn(
                    `Dexscreener request failed (status=${status || 'network'}) attempt ${attempt + 1}, retrying in ${Math.round(wait)}ms`
                );
                await new Promise(r => setTimeout(r, wait));
            }
        }
    }
    throw new Error('Exceeded max retries');
};

// Get single token-pair / price info
const getDexscreenerTokenPrice = async (tokenAddress, chainId) => {
    const key = `${chainId}:${tokenAddress}`;
    if (dexSingleCache.has(key)) {
        console.debug(`Cache hit: for getDexscreenerTokenPrice(${key})`);
        return dexSingleCache.get(key);
    }

    const url = `latest/dex/tokens/${tokenAddress}`;
    try {
        console.debug(`Dexscreener: Fetching price data for ${tokenAddress} on chain ${chainId}`);
        const response = await defaultLimiter.schedule(() =>
            fetchWithRetry(() => api.get(url))
        );
        console.debug(`Dexscreener: Fetched price data for ${tokenAddress}`);
        dexSingleCache.set(key, response.data);

        if (response?.data?.pairs.length> 0) {

            const pairs = Array.isArray(response?.data?.pairs)
                ? response.data.pairs
                : Array.isArray(response?.data)
                    ? response.data
                    : [];

            if (!pairs.length) return null;

            const toUsd = p => Number(p?.liquidity?.usd) || 0;
            const toTs = p => Number(p?.pairCreatedAt) || 0;

            const topPair = pairs.reduce((best, p) => {
                if (!best) return p;
                const bu = toUsd(best), pu = toUsd(p);
                if (pu !== bu) return pu > bu ? p : best;
                return toTs(p) > toTs(best) ? p : best;
            }, null);

            return topPair;
        } else {
            return response?.data?.pairs[0]
        }

    } catch (error) {
        console.error(`Error fetching dexscreener price data for ${tokenAddress}:`, error.response?.data || error.message);
        return null;
    }
};
module.exports = {
    getDexscreenerTokenPrice,
    clearDexCache,
};
