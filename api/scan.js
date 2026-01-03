require('dotenv').config();
const axios = require('axios');

const txCache = new Map();
const tokenTxCache = new Map();

function clearScanCache() {
    txCache.clear();
    tokenTxCache.clear();
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

const defaultLimiter = new SimpleRateLimiter(5); // free: 5 req/sec

const api = axios.create({
    baseURL: 'https://api.etherscan.io/v2/api',
    headers: {
        accept: 'application/json',
    },
    timeout: 60000,
});

// — Логування радіт-лімітів із заголовків відповіді
const logHeaders = (headers) => {
    if (!headers) return;
    ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining']
        .forEach(h => {
            if (headers[h]) console.debug(`[Etherscan Header] ${h}: ${headers[h]}`);
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
                    `Request failed (status=${status || 'network'}) attempt ${attempt + 1}, retrying in ${Math.round(wait)}ms`
                );
                await new Promise(r => setTimeout(r, wait));
            }
        }
    }
};

// Scan API to retrieve all transactions for a given address on a specific chain, з кешем
const getAllTransactions = async (address, chain_id, maxTx = +process.env.SCAN_TRANSACTIONS_COUNT) => {
    const key = `${address}:${chain_id}:${maxTx}`;
    if (txCache.has(key)) {
        return txCache.get(key);
    }

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
            fetchWithRetry(() => api.get('', {params}))
        );

        const all = response.data.result || [];
        const sliced = all.length > maxTx ? all.slice(0, maxTx) : all;

        txCache.set(key, sliced);
        return sliced;
    } catch (error) {
        console.error(`Error fetching transactions for ${address}:`, error.response?.data || error.message);
        return [];
    }
};

// Scan API to retrieve token transfers, з кешем
const getTokenTransfers = async (
    address,
    contractAddress,
    chain_id,
    startBlock = 0,
    endBlock = 99999999
) => {
    const key = `${address}:${contractAddress}:${chain_id}`;
    if (tokenTxCache.has(key)) {
        return tokenTxCache.get(key);
    }

    try {
        const params = {
            module: 'account',
            action: 'tokentx',
            address,
            contractaddress: contractAddress,
            startblock: startBlock,
            endblock: endBlock,
            sort: 'asc',
            apikey: process.env.SCAN_API_KEY,
            chainid: chain_id,
        };

        const response = await defaultLimiter.schedule(() =>
            fetchWithRetry(() => api.get('', {params}))
        );

        const result = response.data.result || [];
        tokenTxCache.set(key, result);
        return result;
    } catch (error) {
        console.error(
            `Error fetching token transfers for ${address} (token: ${contractAddress}):`,
            error.response?.data || error.message
        );
        return [];
    }
};

module.exports = {
    getAllTransactions,
    getTokenTransfers,
    clearScanCache,
};
