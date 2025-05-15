const averageHoldingHours = (trades) => {
    trades.sort((a, b) => new Date(a.blockTimestamp) - new Date(b.blockTimestamp));

    const buyQueue = [];
    const holdingPeriods = [];

    trades.forEach(trade => {
        if (trade.transactionType === 'buy') {
            buyQueue.push(new Date(trade.blockTimestamp));
        } else if (trade.transactionType === 'sell' && buyQueue.length > 0) {
            const buyTime = buyQueue.shift();
            const sellTime = new Date(trade.blockTimestamp);
            const diffMs = sellTime - buyTime;
            const diffHours = diffMs / (1000 * 3600);
            holdingPeriods.push(diffHours);
        }
    });

    if (holdingPeriods.length === 0) {
        return 0;
    }

    const totalHoldingHours = holdingPeriods.reduce((sum, hours) => sum + hours, 0);

    const avgHoldingHours = Number((totalHoldingHours / holdingPeriods.length).toFixed(2));

    return avgHoldingHours;
}

module.exports = {averageHoldingHours};

