const axios = require('axios');

async function getSolanaPrice() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: {
                ids: 'binancecoin',
                vs_currencies: 'usd',
            }
        });

        return response?.data?.binancecoin.usd;
    } catch (error) {
        console.error('ERROR FETCHING SOLANA PRICE — ', error);
        throw error;
    }
}

async function getHistoryTrades(token, unixStartTime) {
    try {
        let offset = 0;
        const limit = 50;
        let allTrades = [];

        while (true) {
            const response = await axios.get(`https://public-api.birdeye.so/defi/txs/token?address=${token}&offset=${offset}&limit=${limit}&tx_type=swap`, {
                headers: {
                    'x-chain': 'bsc',
                    'X-API-KEY': process.env.BIRDEYE_API_KEY,
                }
            });
            allTrades = allTrades.concat(response?.data?.data?.items);

            if (response?.data?.data?.hasNext && allTrades[allTrades.length - 1].blockUnixTime > unixStartTime) {
                offset += limit;
            } else {
                break;
            }
        }

        return allTrades;
    } catch (error) {
        console.error('Error fetching Solana transactions:', error.message);
        throw error;
    }
}


async function getTrades(address) {
    try {
        const limit = 100;
        let allTrades = [];
        let hasNext = true;
        let afterTime = 0;

        while (hasNext) {
            const response = await axios.get(
                `https://public-api.birdeye.so/trader/txs/seek_by_time`,
                {
                    params: {
                        address,
                        offset: 0,
                        limit,
                        tx_type: 'all',
                        sort_type: 'asc',
                        before_time: afterTime,
                        after_time: 0,
                    },
                    headers: {
                        'x-chain': 'bsc',
                        'X-API-KEY': process.env.BIRDEYE_API_KEY,
                    },
                }
            );

            const items = response?.data?.data?.items || [];
            allTrades.push(...items);

            if (allTrades.length > process.env.COUNT_TRADE) {
                console.log('NUMBER OF TRADES EXCEEDS', process.env.COUNT_TRADE);
                return [];
            }

            if (items.length > 0) {
                afterTime = items[items.length - 1]?.block_unix_time || afterTime;
            }

            hasNext = items.length === limit && response?.data?.data?.has_next;
        }

        return allTrades;
    } catch (error) {
        console.error('ERROR FETCHING TRADES — ', error.message);
        throw error;
    }
}


async function getTokenHistoryTransactions(address, retryCount = 0) {
    try {
        let allHistory = [];
        let before = '';
        let count = 0;

        while (true) {
            const response = await axios.get(
                `https://public-api.birdeye.so/v1/wallet/tx_list?wallet=${address}&limit=1000&before=${before}`,
                {
                    headers: {
                        'x-chain': 'bsc',
                        'X-API-KEY': process.env.BIRDEYE_API_KEY
                    }
                },
            );
            const data = response?.data?.data?.bsc
                .filter(item => item?.balanceChange && item?.balanceChange.length > 1)
                .filter(item => item?.balanceChange[0]?.amount !== 0)
                .filter(item => item?.balanceChange[1]?.name !== undefined)
                .filter(item => item?.balanceChange[1]?.symbol !== undefined)
                .filter(item => item?.status !== false);
            allHistory = allHistory.concat(data);
            if (response?.data?.data?.bsc.length > 0 && count < 5) {
                count += 1;
                before = response?.data?.data?.bsc[response?.data?.data?.bsc.length - 1].txHash;
            } else {
                break;
            }
        }
        return allHistory;
    } catch (error) {
        console.error('Error fetching Solana transactions:', error);
        if (error.response?.status === 504 && retryCount < 3) {
            console.log(`Retry attempt #${retryCount + 1} for ${address}`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            return getTokenHistoryTransactions(address, retryCount + 1);
        } else {
            throw error;
        }
    }
}

async function getTokenBalances(address, retryCount = 0) {
    try {
        const response = await axios.get(
            `https://public-api.birdeye.so/v1/wallet/token_list?wallet=${address}`,
            {
                headers: {
                    'x-chain': 'bsc',
                    'X-API-KEY': process.env.BIRDEYE_API_KEY,
                }
            },
        );
        return response?.data?.data?.items;
    } catch (error) {
        console.error('Error fetching token balance:', error.message);
        if (error.response?.status === 504 && retryCount < 3) {
            console.log(`Retry attempt #${retryCount + 1} for ${address}`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            return getTokenBalances(address, retryCount + 1);
        } else {
            throw error;
        }
    }
}

async function getHistoryTokenPrice(address, timeFrom, retryCount = 0) {
    try {
        const response = await axios.get(
            `https://public-api.birdeye.so/defi/history_price?address=${address}&address_type=token&type=1m&time_from=${timeFrom}&time_to=${timeFrom + 60}`,
            {
                headers: {
                    'x-chain': 'bsc',
                    'X-API-KEY': process.env.BIRDEYE_API_KEY,
                }
            },
        );
        return response?.data?.data?.items[0]?.value || 0;
    } catch (error) {
        console.error('Error fetching token history price:', error.message);
        if (error.response?.status === 504 && retryCount < 3) {
            console.log(`Retry attempt #${retryCount + 1} for ${address}`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            return getHistoryTokenPrice(address, timeFrom, retryCount + 1);
        } else {
            throw error;
        }
    }
}

async function getAddressListTransaction(address) {
    try {
        const response = await axios.get(`https://api.bscscan.com/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&apikey=${process.env.BSCSCAN_API_KEY}`);
        return response.data.result;
    } catch (error) {
        console.error('Error fetching data:', error.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
        return getAddressListTransaction(address);
    }
}

module.exports = {
    getSolanaPrice,
    getTokenBalances,
    getHistoryTrades,
    getTokenHistoryTransactions,
    getHistoryTokenPrice,
    getTrades,
    getAddressListTransaction
};
