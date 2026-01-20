require('dotenv').config();
const axios = require('axios');
const { logger } = require('../performanceLogger');

const codeCache = new Map();

// PRO plan: 100 CU/s for RPC nodes
const RPC_THROUGHPUT_CU_PER_SEC = 100;
const BATCH_SIZE = 15; // Зменшено: 15 * 3 = 45 CU (можна 2 batch/s)
const GET_CODE_CU = 3;

// In-flight tracking для дедуплікації
const inFlightRequests = new Map();

class RpcRateLimiter {
    constructor(cuPerSec) {
        this.cuPerSec = cuPerSec;
        this.availableCU = cuPerSec;
        this.queue = [];
        this.lastRequestTime = 0;
        // Refill кожні 50ms для плавнішого throughput
        this.refillInterval = setInterval(() => this.refill(), 50);
    }

    refill() {
        // Refill 1/20 за 50ms = повний refill за секунду
        this.availableCU = Math.min(this.cuPerSec, this.availableCU + this.cuPerSec / 20);
        this.processQueue();
    }

    processQueue() {
        while (this.queue.length) {
            const item = this.queue[0];
            if (this.availableCU >= item.cost) {
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
            if (this.availableCU >= cost) {
                this.availableCU -= cost;
                fn().then(resolve).catch(reject);
            } else {
                this.queue.push({ cost, fn, resolve, reject });
            }
        });
    }

    getQueueStatus() {
        return {
            queueLength: this.queue.length,
            availableCU: Math.round(this.availableCU)
        };
    }
}

const rateLimiter = new RpcRateLimiter(RPC_THROUGHPUT_CU_PER_SEC);

// ============================================================
// RETRY LOGIC для 429 помилок
// ============================================================
const fetchWithRetry = async (fn, maxRetries = 4) => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = err.response?.status;
            const isRetryable = status === 429 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';

            if (attempt === maxRetries || !isRetryable) {
                throw err;
            }

            // Експоненційний backoff: 200, 400, 800, 1600ms
            const backoff = 200 * Math.pow(2, attempt);
            const jitter = Math.random() * 100;
            const wait = backoff + jitter;

            logger.logWarning(`RPC retry ${attempt + 1}/${maxRetries} in ${Math.round(wait)}ms (status=${status})`);
            await new Promise(r => setTimeout(r, wait));
        }
    }
};

// ============================================================
// GET CODE - single address
// ============================================================
const getCode = async (address, rpcUrl, chain) => {
    const addrLower = address.toLowerCase();
    const cacheKey = `${chain}:${addrLower}`;

    if (codeCache.has(cacheKey)) {
        return codeCache.get(cacheKey);
    }

    // Check in-flight
    if (inFlightRequests.has(cacheKey)) {
        return inFlightRequests.get(cacheKey);
    }

    const requestPromise = (async () => {
        const timer = logger.startOperation('RPC', 'getCode', `${chain}:${address.slice(0, 10)}...`);

        try {
            const response = await rateLimiter.schedule(GET_CODE_CU, () =>
                fetchWithRetry(() =>
                    axios.post(rpcUrl, {
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'eth_getCode',
                        params: [address, 'latest']
                    }, { timeout: 10000 })
                )
            );

            const isEOA = (response.data.result === '0x' || response.data.result === '0x0');
            codeCache.set(cacheKey, isEOA);

            logger.endOperation(timer);
            return isEOA;
        } catch (err) {
            logger.endOperation(timer);
            logger.logError(`RPC getCode failed for ${chain}: ${err.message}`);
            return null;
        } finally {
            inFlightRequests.delete(cacheKey);
        }
    })();

    inFlightRequests.set(cacheKey, requestPromise);
    return requestPromise;
};

// ============================================================
// BATCH GET CODE - multiple addresses
// ============================================================
const batchGetCode = async (addresses, rpcUrl, chain) => {
    const timer = logger.startOperation('RPC', 'batchGetCode', `${chain}, ${addresses.length} addresses`);

    const requests = addresses.map((addr, index) => ({
        jsonrpc: '2.0',
        id: index,
        method: 'eth_getCode',
        params: [addr, 'latest']
    }));

    const batchCost = addresses.length * GET_CODE_CU;

    try {
        const response = await rateLimiter.schedule(batchCost, () =>
            fetchWithRetry(() =>
                axios.post(rpcUrl, requests, { timeout: 15000 })
            )
        );

        const results = new Map();

        if (Array.isArray(response.data)) {
            response.data.forEach((res, index) => {
                const addr = addresses[index];
                const cacheKey = `${chain}:${addr.toLowerCase()}`;
                const isEOA = (res.result === '0x' || res.result === '0x0');
                codeCache.set(cacheKey, isEOA);
                results.set(addr.toLowerCase(), isEOA);
            });
        }

        logger.endOperation(timer);
        return results;
    } catch (err) {
        logger.endOperation(timer);
        logger.logError(`Batch RPC error ${chain}: ${err.message}`);
        return new Map();
    }
};

// ============================================================
// PREFETCH ADDRESSES - з контролем швидкості
// ============================================================
const prefetchAddresses = async (addresses, rpcUrl, chain) => {
    const unique = [...new Set(addresses.map(a => a.toLowerCase()))];
    const uncached = unique.filter(addr => !codeCache.has(`${chain}:${addr}`));

    if (uncached.length === 0) {
        logger.logInfo(`Prefetch: all ${unique.length} addresses already cached`);
        return;
    }

    logger.logInfo(`Prefetch: ${uncached.length}/${unique.length} addresses need fetching`);

    // Batch по 15 адрес = 45 CU
    // При 100 CU/s можна робити ~2 batch/s
    // Додаємо мінімальну затримку 500ms між batch для стабільності
    const MIN_BATCH_DELAY = 500;

    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        const batch = uncached.slice(i, i + BATCH_SIZE);
        await batchGetCode(batch, rpcUrl, chain);

        // Затримка між batch запитами (крім останнього)
        if (i + BATCH_SIZE < uncached.length) {
            await new Promise(r => setTimeout(r, MIN_BATCH_DELAY));
        }
    }
};

// ============================================================
// PARALLEL PREFETCH - для багатьох адрес з контролем concurrency
// ============================================================
const prefetchAddressesParallel = async (addresses, rpcUrl, chain, concurrency = 2) => {
    const unique = [...new Set(addresses.map(a => a.toLowerCase()))];
    const uncached = unique.filter(addr => !codeCache.has(`${chain}:${addr}`));

    if (uncached.length === 0) {
        logger.logInfo(`Prefetch: all ${unique.length} addresses already cached`);
        return;
    }

    logger.logInfo(`Prefetch parallel: ${uncached.length}/${unique.length} addresses (concurrency: ${concurrency})`);

    // Розбиваємо на batch
    const batches = [];
    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        batches.push(uncached.slice(i, i + BATCH_SIZE));
    }

    // Обробляємо по `concurrency` batch одночасно
    for (let i = 0; i < batches.length; i += concurrency) {
        const chunk = batches.slice(i, i + concurrency);
        await Promise.all(
            chunk.map(batch => batchGetCode(batch, rpcUrl, chain))
        );

        // Затримка між групами batch запитів
        if (i + concurrency < batches.length) {
            await new Promise(r => setTimeout(r, 600));
        }
    }
};

const clearCodeCache = () => {
    const size = codeCache.size;
    codeCache.clear();
    inFlightRequests.clear();
    logger.logInfo(`RPC code cache cleared (${size} entries)`);
};

const getCacheStats = () => ({
    size: codeCache.size,
    inFlight: inFlightRequests.size
});

module.exports = {
    getCode,
    prefetchAddresses,
    prefetchAddressesParallel,
    clearCodeCache,
    getCacheStats
};
