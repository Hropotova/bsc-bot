const transactionsFrequency = (address, transactions) => {
    transactions.sort((a, b) => new Date(a.block_timestamp) - new Date(b.block_timestamp));

    if (transactions.length < 2) {
        return {
            dormant_days: 0,
            longest_gap_days: 0,
            total_period_days: 0,
            dormant_percent: 0,
        };
    }

    const gaps = [];

    for (let i = 0; i < transactions.length - 1; i++) {
        const currentTimestamp = new Date(transactions[i].block_timestamp).getTime();
        const nextTimestamp = new Date(transactions[i + 1].block_timestamp).getTime();
        const gapDays = (nextTimestamp - currentTimestamp) / (1000 * 86400);
        gaps.push(gapDays);
    }

    const dormant_days = gaps.filter((gap) => gap > 7).reduce((sum, gap) => sum + gap, 0).toFixed(2);

    const longest_gap_days = Math.max(...gaps).toFixed(2);
    const firstTimestamp = new Date(transactions[0].block_timestamp).getTime();
    const lastTimestamp = new Date(transactions[transactions.length - 1].block_timestamp).getTime();

    const total_period_days = ((lastTimestamp - firstTimestamp) / (1000 * 86400)).toFixed(2);

    const dormant_percent = (total_period_days > 0 ? (dormant_days / total_period_days) * 100 : 0).toFixed(2);

    return {
        dormant_days,
        longest_gap_days,
        total_period_days,
        dormant_percent,
    };
}

module.exports = {transactionsFrequency};

