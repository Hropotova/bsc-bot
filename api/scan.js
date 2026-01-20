require('dotenv').config();
const axios = require('axios');
const { logger } = require('../performanceLogger');

const txCache = new Map();
const tokenTxCache = new Map();

// In-flight request tracking
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

// ============================================================
// OPTIMIZED RATE LIMITER - збільшений throughput
// ============================================================
class SimpleRateLimiter {
    constructor(maxPerSecond) {
        this.maxPerSecond = maxPerSecond;
        this.tokens = maxPerSecond;
        this.queue = [];
        this.processing = false;

        // Refill частіше - кожні 200ms замість 1000ms
        setInterval(() => {
            this.tokens = Math.min(this.maxPerSecond, this.tokens + this.maxPerSecond / 5);
            this._processQueue();
        }, 200);
    }

    _processQueue() {
        if (this.processing) return;
        this.processing = true;

        while (this.tokens >= 1 && this.queue.length) {
            const { fn, resolve, reject } = this.queue.shift();
            this.tokens--;
            fn().then(resolve).catch(reject);
        }

        this.processing = false;
    }

    schedule(fn) {
        return new Promise((resolve, reject) => {
            if (this.tokens >= 1) {
                this.tokens--;
                fn().then(resolve).catch(reject);
            } else {
                this.queue.push({ fn, resolve, reject });
            }
        });
    }

    // Batch scheduling для паралельних запитів
    async scheduleBatch(fns) {
        return Promise.all(fns.map(fn => this.schedule(fn)));
    }

    getQueueStatus() {
        return {
            queueLength: this.queue.length,
            availableTokens: Math.round(this.tokens)
        };
    }
}

// Збільшений ліміт: 10 замість 5
const defaultLimiter = new SimpleRateLimiter(10);

const api = axios.create({
    baseURL: 'https://api.etherscan.io/v2/api',
    headers: {
        accept: 'application/json',
    },
    timeout: 45000, // трохи менший timeout
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

            const backoff = 150 * Math.pow(2, attempt); // швидше: 150 замість 200
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

// ============================================================
// GET ALL TRANSACTIONS
// ============================================================

const getAllTransactions = async (address, chain_id, maxTx = +process.env.SCAN_TRANSACTIONS_COUNT) => {
    const key = `tx:${address}:${chain_id}:${maxTx}`;
    if (txCache.has(key)) {
        logger.logInfo(`Scan transactions CACHE HIT: ${address.slice(0, 10)}...`);
        return txCache.get(key);
    }

    // Check in-flight
    if (inFlightRequests.has(key)) {
        logger.logInfo(`Scan transactions IN-FLIGHT: ${address.slice(0, 10)}...`);
        return inFlightRequests.get(key);
    }

    const requestPromise = (async () => {
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
        } finally {
            inFlightRequests.delete(key);
        }
    })();

    inFlightRequests.set(key, requestPromise);
    return requestPromise;
};

// ============================================================
// GET TOKEN TRANSFERS - з in-flight deduplication
// ============================================================

const getTokenTransfers = async (
    address,
    contractAddress,
    chain_id,
    startBlock = 0,
    endBlock = 99999999
) => {
    const cacheKey = `${address.toLowerCase()}:${contractAddress.toLowerCase()}:${chain_id}`;

    if (tokenTxCache.has(cacheKey)) {
        return tokenTxCache.get(cacheKey);
    }

    if (inFlightRequests.has(cacheKey)) {
        return inFlightRequests.get(cacheKey);
    }

    const requestPromise = (async () => {
        const timer = logger.startOperation('Scan', 'getTokenTransfers',
            `chain ${chain_id}:${address.slice(0, 10)}... token:${contractAddress.slice(0, 10)}...`);

        try {
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

// ============================================================
// PARALLEL PREFETCH - паралельне завантаження для багатьох контрактів
// ============================================================

/**
 * Prefetch token transfers для багатьох контрактів паралельно
 * @param {string} address - адреса гаманця
 * @param {string[]} contractAddresses - масив адрес контрактів
 * @param {number} chain_id - ID мережі
 * @param {number} concurrency - кількість паралельних запитів (default: 8)
 */
const prefetchTokenTransfers = async (address, contractAddresses, chain_id, concurrency = 8) => {
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

    logger.logInfo(`Prefetch: ${uncached.length}/${unique.length} contracts need fetching (concurrency: ${concurrency})`);

    const timer = logger.startOperation('Scan', 'prefetchTokenTransfers', `${uncached.length} contracts`);

    // Process in parallel chunks
    for (let i = 0; i < uncached.length; i += concurrency) {
        const chunk = uncached.slice(i, i + concurrency);
        await Promise.all(
            chunk.map(contract => getTokenTransfers(address, contract, chain_id))
        );

        // Логуємо прогрес
        if (i + concurrency < uncached.length) {
            logger.logInfo(`  └─ Prefetched ${Math.min(i + concurrency, uncached.length)}/${uncached.length} contracts`);
        }
    }

    logger.endOperation(timer);
    logger.logInfo(`Prefetch complete: ${uncached.length} contracts loaded`);
};

// ============================================================
// BATCH TRANSACTIONS - для багатьох адрес одразу
// ============================================================

/**
 * Завантажує транзакції для багатьох адрес паралельно
 * @param {string[]} addresses - масив адрес
 * @param {number} chain_id - ID мережі
 * @param {number} concurrency - кількість паралельних запитів
 * @returns {Map<string, Array>} - Map з адресою як ключем
 */
const getAllTransactionsBatch = async (addresses, chain_id, concurrency = 5) => {
    const results = new Map();
    const uncached = [];

    // Check cache first
    for (const addr of addresses) {
        const key = `tx:${addr}:${chain_id}:${process.env.SCAN_TRANSACTIONS_COUNT}`;
        if (txCache.has(key)) {
            results.set(addr.toLowerCase(), txCache.get(key));
        } else {
            uncached.push(addr);
        }
    }

    if (uncached.length === 0) {
        logger.logInfo(`Batch transactions: all ${addresses.length} from cache`);
        return results;
    }

    logger.logInfo(`Batch transactions: ${uncached.length}/${addresses.length} need fetching`);

    const timer = logger.startOperation('Scan', 'getAllTransactionsBatch', `${uncached.length} addresses`);

    // Process in parallel chunks
    for (let i = 0; i < uncached.length; i += concurrency) {
        const chunk = uncached.slice(i, i + concurrency);
        const chunkResults = await Promise.all(
            chunk.map(async (addr) => {
                const txs = await getAllTransactions(addr, chain_id);
                return { addr: addr.toLowerCase(), txs };
            })
        );

        for (const { addr, txs } of chunkResults) {
            results.set(addr, txs);
        }
    }

    logger.endOperation(timer);
    return results;
};

module.exports = {
    getAllTransactions,
    getTokenTransfers,
    prefetchTokenTransfers,
    getAllTransactionsBatch,
    clearScanCache,
};
