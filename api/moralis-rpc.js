require('dotenv').config();
const axios = require('axios');

const codeCache = new Map();

const RPC_THROUGHPUT_CU_PER_SEC = 100;
const BATCH_SIZE = 20; // Максимум для batch
const GET_CODE_CU = 3; // eth_getCode = 3 CU

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
}

const rateLimiter = new RpcRateLimiter(RPC_THROUGHPUT_CU_PER_SEC);

const getCode = async (address, rpcUrl, chain) => {
    const cacheKey = `${chain}:${address.toLowerCase()}`;

    if (codeCache.has(cacheKey)) {
        return codeCache.get(cacheKey);
    }

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
        return isEOA;
    } catch (err) {
        console.error(`Error fetching ${chain} node:`, err.message);
        return null;
    }
};

const batchGetCode = async (addresses, rpcUrl, chain) => {
    const requests = addresses.map((addr, index) => ({
        jsonrpc: '2.0',
        id: index,
        method: 'eth_getCode',
        params: [addr, 'latest']
    }));

    const batchCost = addresses.length * GET_CODE_CU; // 20 × 3 = 60 CU

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
    } catch (err) {
        console.error(`Batch error ${chain}:`, err.message);
    }
};

const prefetchAddresses = async (addresses, rpcUrl, chain) => {
    const unique = [...new Set(addresses.map(a => a.toLowerCase()))];
    const uncached = unique.filter(addr => !codeCache.has(`${chain}:${addr}`));

    if (uncached.length === 0) return;

    console.log(`Prefetching ${uncached.length} addresses...`);

    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        const batch = uncached.slice(i, i + BATCH_SIZE);
        await batchGetCode(batch, rpcUrl, chain);
    }

    console.log(`Prefetch complete: ${uncached.length} addresses cached`);
};

const clearCodeCache = () => codeCache.clear();

module.exports = { getCode, prefetchAddresses, clearCodeCache };
