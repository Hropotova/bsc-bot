require('dotenv').config();
const axios = require('axios');
const { logger } = require('../performanceLogger');

const txCache = new Map();
const tokenTxCache = new Map();

// In-flight request tracking - ключ БЕЗ блоків
const inFlightRequests = new Map();

function clearScanCache() {
    const stats = {
        transactions: txCache.size,
        tokenTransfers: tokenTxCache.size
    };
    txCache.clear();
    tokenTxCache.clear();
    inFlightRequests.clear();
    logger.logInfo(`Scan cache cleared: ${JSON.stringify(stats)}`);
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
    baseURL: 'https://api.etherscan.io/v2/api',
    headers: {
        accept: 'application/json',
    },
    timeout: 60000,
});

const logHeaders = (headers) => {
    if (!headers) return;
    const remaining = headers['x-ratelimit-remaining'];
    if (remaining && parseInt(remaining) < 10) {
        logger.logWarning(`Etherscan rate limit low: ${remaining} remaining`);
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
                logger.logWarning(`Etherscan retry-after: ${retryAfter}s`);
                await new Promise(r => setTimeout(r, serverWait + 100));
            } else {
                logger.logWarning(`Etherscan retry ${attempt + 1}/${maxRetries} in ${Math.round(wait)}ms`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
    }
};

const getAllTransactions = async (address, chain_id, maxTx = +process.env.SCAN_TRANSACTIONS_COUNT) => {
    const key = `tx:${address}:${chain_id}:${maxTx}`;
    if (txCache.has(key)) {
        logger.logInfo(`Scan transactions CACHE HIT: ${address.slice(0, 10)}...`);
        return txCache.get(key);
    }

    const timer = logger.startOperation('Scan', 'getAllTransactions', `chain ${chain_id}:${address.slice(0, 10)}...`);

    try {
        const params = {
            module: 'account',
            action: 'txlist',
            address,
            startblock: 0,
            endblock: 99999999,
            sort: 'asc',
            apikey: process.env.SCAN_API_KEY,
            chainid: chain_id,
            page: 1,
            offset: maxTx,
        };

        const response = await defaultLimiter.schedule(() =>
            fetchWithRetry(() => api.get('', { params }))
        );

        const all = response.data.result || [];
        const sliced = all.length > maxTx ? all.slice(0, maxTx) : all;

        txCache.set(key, sliced);
        logger.endOperation(timer);
        logger.logInfo(`  └─ ${sliced.length} transactions`);
        return sliced;
    } catch (error) {
        logger.endOperation(timer);
        logger.logError(`Scan transactions failed: ${error.response?.data || error.message}`);
        return [];
    }
};

/**
 * Get token transfers with in-flight deduplication
 *
 * ВАЖЛИВО: startBlock/endBlock ігноруються для кешування!
 * Завжди завантажуємо ВСІ трансфери і кешуємо.
 * Логіка валідації просто перевіряє чи існують трансфери взагалі.
 */
const getTokenTransfers = async (
    address,
    contractAddress,
    chain_id,
    startBlock = 0,
    endBlock = 99999999
) => {
    // Ключ БЕЗ блоків - завжди кешуємо повний результат
    const cacheKey = `${address.toLowerCase()}:${contractAddress.toLowerCase()}:${chain_id}`;

    // 1. Перевіряємо кеш
    if (tokenTxCache.has(cacheKey)) {
        return tokenTxCache.get(cacheKey);
    }

    // 2. Перевіряємо чи вже є in-flight запит
    if (inFlightRequests.has(cacheKey)) {
        return inFlightRequests.get(cacheKey);
    }

    // 3. Створюємо новий запит
    const requestPromise = (async () => {
        const timer = logger.startOperation('Scan', 'getTokenTransfers',
            `chain ${chain_id}:${address.slice(0, 10)}... token:${contractAddress.slice(0, 10)}...`);

        try {
            // Завжди запитуємо ВСІ трансфери (0-99999999)
            const params = {
                module: 'account',
                action: 'tokentx',
                address,
                contractaddress: contractAddress,
                startblock: 0,
                endblock: 99999999,
                sort: 'asc',
                apikey: process.env.SCAN_API_KEY,
                chainid: chain_id,
            };

            const response = await defaultLimiter.schedule(() =>
                fetchWithRetry(() => api.get('', { params }))
            );

            const result = response.data.result || [];
            tokenTxCache.set(cacheKey, result);
            logger.endOperation(timer);
            logger.logInfo(`  └─ ${result.length} token transfers`);
            return result;
        } catch (error) {
            logger.endOperation(timer);
            logger.logError(`Scan token transfers failed: ${error.response?.data || error.message}`);
            return [];
        } finally {
            inFlightRequests.delete(cacheKey);
        }
    })();

    inFlightRequests.set(cacheKey, requestPromise);
    return requestPromise;
};

/**
 * Prefetch token transfers for multiple contracts in parallel
 */
const prefetchTokenTransfers = async (address, contractAddresses, chain_id, concurrency = 5) => {
    const unique = [...new Set(contractAddresses.map(a => a.toLowerCase()))];
    const addressLower = address.toLowerCase();

    // Filter already cached or in-flight
    const uncached = unique.filter(contract => {
        const key = `${addressLower}:${contract}:${chain_id}`;
        return !tokenTxCache.has(key) && !inFlightRequests.has(key);
    });

    if (uncached.length === 0) {
        logger.logInfo(`Prefetch: all ${unique.length} contracts already cached/in-flight`);
        return;
    }

    logger.logInfo(`Prefetch: ${uncached.length}/${unique.length} contracts need fetching`);

    // Process in chunks
    for (let i = 0; i < uncached.length; i += concurrency) {
        const chunk = uncached.slice(i, i + concurrency);
        await Promise.all(
            chunk.map(contract => getTokenTransfers(address, contract, chain_id))
        );
    }
};

module.exports = {
    getAllTransactions,
    getTokenTransfers,
    prefetchTokenTransfers,
    clearScanCache,
};
