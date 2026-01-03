const getOldestBuyTimestamp = (trades) => {
    let oldestTimestamp = null;

    for (const trade of trades || []) {
        if (trade && trade.transactionType === 'buy' && trade.blockTimestamp) {
            const timestamp = Date.parse(trade.blockTimestamp);
            if (!Number.isNaN(timestamp)) {
                if (oldestTimestamp === null || timestamp < oldestTimestamp) {
                    oldestTimestamp = timestamp;
                }
            }
        }
    }

    return oldestTimestamp !== null && new Date(oldestTimestamp).toISOString();
}

module.exports = {getOldestBuyTimestamp};
