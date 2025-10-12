function toMs(ts) {
    if (ts == null) return NaN;
    if (typeof ts === 'number') {
        return ts < 1e12 ? ts * 1000 : ts;
    }
    const ms = Date.parse(ts);
    return Number.isNaN(ms) ? NaN : ms;
}

const transactionsFrequency = (address, transactions = [], swaps = []) => {
    const txSorted = [...transactions]
        .map(t => toMs(t?.block_timestamp))
        .filter(ms => Number.isFinite(ms))
        .sort((a, b) => a - b);

    if (txSorted.length < 2) {
        return {dormant_percent: 0};
    }

    const firstTimestamp = txSorted[0];
    const lastTimestamp = txSorted[txSorted.length - 1];
    const total_period_days = Number(((lastTimestamp - firstTimestamp) / (1000 * 86400)).toFixed(2));

    const swapTimes = [...swaps]
        .map(s => toMs(s?.blockTimestamp))
        .filter(ms => Number.isFinite(ms))
        .sort((a, b) => a - b);

    let dormant_days = 0;

    if (swapTimes.length >= 2) {
        for (let i = 0; i < swapTimes.length - 1; i++) {
            const gapDays = (swapTimes[i + 1] - swapTimes[i]) / (1000 * 86400);
            if (gapDays > 7) {
                dormant_days += gapDays;
            }
        }
        dormant_days = Number(dormant_days.toFixed(2));
    }

    const dormant_percent = Number(
        (total_period_days > 0 ? (dormant_days / total_period_days) * 100 : 0).toFixed(2)
    );

    return {dormant_percent};
};

module.exports = {transactionsFrequency};
