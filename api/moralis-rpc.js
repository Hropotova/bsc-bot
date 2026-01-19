require('dotenv').config();
const axios = require('axios');
const { logger } = require('../performanceLogger');

const codeCache = new Map();

const RPC_THROUGHPUT_CU_PER_SEC = 100;
const BATCH_SIZE = 20;
const GET_CODE_CU = 3;

class RpcRateLimiter {
    constructor(cuPerSec) {
        this.cuPerSec = cuPerSec;
        this.availableCU = cuPerSec;
        this.queue = [];
        this.refillInterval = setInterval(() => this.refill(), 100);
    }

    refill() {
        this.availableCU = Math.min(this.cuPerSec, this.availableCU + this.cuPerSec / 10);
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
            this.queue.push({ cost, fn, resolve, reject });
            this.processQueue();
        });
    }

    // Логування стану черги
    getQueueStatus() {
        return {
            queueLength: this.queue.length,
            availableCU: Math.round(this.availableCU)
        };
    }
}

const rateLimiter = new RpcRateLimiter(RPC_THROUGHPUT_CU_PER_SEC);

const getCode = async (address, rpcUrl, chain) => {
    const cacheKey = `${chain}:${address.toLowerCase()}`;

    if (codeCache.has(cacheKey)) {
        // Не логуємо кожен cache hit для getCode - їх дуже багато
        return codeCache.get(cacheKey);
    }

    const timer = logger.startOperation('RPC', 'getCode', `${chain}:${address.slice(0, 10)}...`);

    try {
        const response = await rateLimiter.schedule(GET_CODE_CU, () =>
            axios.post(rpcUrl, {
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_getCode',
                params: [address, 'latest']
            })
        );
        const isEOA = (response.data.result === '0x' || response.data.result === '0x0');
        codeCache.set(cacheKey, isEOA);

        logger.endOperation(timer);
        return isEOA;
    } catch (err) {
        logger.endOperation(timer);
        logger.logError(`RPC getCode failed for ${chain}: ${err.message}`);
        return null;
    }
};

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
            axios.post(rpcUrl, requests)
        );

        response.data.forEach((res, index) => {
            const addr = addresses[index];
            const cacheKey = `${chain}:${addr.toLowerCase()}`;
            const isEOA = (res.result === '0x' || res.result === '0x0');
            codeCache.set(cacheKey, isEOA);
        });

        logger.endOperation(timer);
    } catch (err) {
        logger.endOperation(timer);
        logger.logError(`Batch RPC error ${chain}: ${err.message}`);
    }
};

const prefetchAddresses = async (addresses, rpcUrl, chain) => {
    const unique = [...new Set(addresses.map(a => a.toLowerCase()))];
    const uncached = unique.filter(addr => !codeCache.has(`${chain}:${addr}`));

    if (uncached.length === 0) {
        logger.logInfo(`Prefetch: all ${unique.length} addresses already cached`);
        return;
    }

    logger.logInfo(`Prefetch: ${uncached.length}/${unique.length} addresses need fetching`);

    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        const batch = uncached.slice(i, i + BATCH_SIZE);
        await batchGetCode(batch, rpcUrl, chain);
    }
};

const clearCodeCache = () => {
    const size = codeCache.size;
    codeCache.clear();
    logger.logInfo(`RPC code cache cleared (${size} entries)`);
};

const getCacheStats = () => ({
    size: codeCache.size
});

module.exports = { getCode, prefetchAddresses, clearCodeCache, getCacheStats };
