require('dotenv').config();
const axios = require('axios');

const codeCache = new Map();

const BATCH_SIZE = 20;
const BATCH_DELAY = 100;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getCode = async (address, rpcUrl, chain) => {
    const cacheKey = `${chain}:${address.toLowerCase()}`;

    if (codeCache.has(cacheKey)) {
        return codeCache.get(cacheKey);
    }

    try {
        const response = await axios.post(rpcUrl, {
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getCode',
            params: [address, 'latest']
        });
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

    try {
        const response = await axios.post(rpcUrl, requests);
        const results = response.data;

        results.forEach((res, index) => {
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

    console.log(`Prefetching ${uncached.length} addresses with batch...`);

    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        const batch = uncached.slice(i, i + BATCH_SIZE);
        await batchGetCode(batch, rpcUrl, chain);

        if (i + BATCH_SIZE < uncached.length) {
            await sleep(BATCH_DELAY);
        }
    }

    console.log(`Prefetch complete: ${uncached.length} addresses cached`);
};

const clearCodeCache = () => codeCache.clear();

module.exports = {getCode, prefetchAddresses, clearCodeCache};
