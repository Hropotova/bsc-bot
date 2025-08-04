require('dotenv').config();
const axios = require('axios');

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
    // Shouldn't reach here due to throw, but fallback
    throw new Error('Exceeded max retries');
};

// Get single token-pair / price info
const getDexscreenerTokenPrice = async (tokenAddress, chainId) => {
    const url = `token-pairs/v1/${chainId}/${tokenAddress}`;
    try {
        console.log(`Dexscreener: Fetching price data for ${tokenAddress} on chain ${chainId}`);
        const response = await defaultLimiter.schedule(() =>
            fetchWithRetry(() => api.get(url))
        );
        console.log(`Dexscreener: Fetched price data for ${tokenAddress}`);
        return response.data;
    } catch (error) {
        console.error(`Error fetching dexscreener price data for ${tokenAddress}:`, error.response?.data || error.message);
        return null;
    }
};

// Get multiple token-pairs in batch (up to provider limit, e.g., 30 addresses)
const getDexscreenerMultipleTokenPrices = async (chainId, tokenAddresses = []) => {
    if (!Array.isArray(tokenAddresses) || tokenAddresses.length === 0) {
        return null;
    }
    // optionally enforce a max batch size if needed (e.g., 30)
    const MAX_BATCH = 30;
    if (tokenAddresses.length > MAX_BATCH) {
        throw new Error(`Too many token addresses in batch, max is ${MAX_BATCH}`);
    }

    const joined = tokenAddresses.join(',');
    const url = `tokens/v1/${chainId}/${joined}`;

    try {
        console.log(`Dexscreener: Fetching batched price data for ${tokenAddresses.length} tokens on chain ${chainId}`);
        const response = await defaultLimiter.schedule(() =>
            fetchWithRetry(() => api.get(url))
        );
        console.log(`Dexscreener: Fetched batched price data`);
        return response.data;
    } catch (error) {
        console.error(`Error fetching dexscreener batched price data:`, error.response?.data || error.message);
        return null;
    }
};

module.exports = {
    getDexscreenerTokenPrice,
    getDexscreenerMultipleTokenPrices,
};
