const {getTokenTransactions, decodeTransaction} = require('../api/moralis');

const checkTransactionHistory = async (address, swaps) => {
    const swapsByContract = {};
    for (const swap of swaps) {
        const tokenAddress = swap?.baseToken;
        if (!tokenAddress) continue;
        if (!swapsByContract[tokenAddress.toLowerCase()]) {
            swapsByContract[tokenAddress.toLowerCase()] = [];
        }
        swapsByContract[tokenAddress.toLowerCase()].push(swap);
    }

    const contractAddresses = Object.keys(swapsByContract);

    const additionalTransfers = await getTokenTransactions(address, contractAddresses);

    const swapHashes = new Set(swaps.map((s) => s.transactionHash.toLowerCase()));
    const missingTransfers = additionalTransfers.filter(
        (tx) => !swapHashes.has(tx.transaction_hash.toLowerCase())
    );

    const swapsArray = [];
    const transfersArray = [];

    for (const [i, tx] of missingTransfers.entries()) {
        const decorated = await decodeTransaction(tx.transaction_hash);
        if (decorated) {
            const isSwap = decorated.logs.some(
                (log) =>
                    log.topic0 ===
                    '0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942' ||
                    decorated.input.startsWith('0x7fc97d9b')
            );

            if (isSwap) {
                const transfers = decorated.logs.filter(
                    (log) =>
                        log.topic0 ===
                        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
                );

                const userAddress = decorated.from_address.toLowerCase();
                let received = null;
                let sent = null;

                for (const log of transfers) {
                    const topic1 = `0x${log.topic1.slice(26)}`.toLowerCase();
                    const topic2 = `0x${log.topic2.slice(26)}`.toLowerCase();
                    const value = log.data;
                    const token = log.address.toLowerCase();

                    if (topic1 === userAddress) {
                        sent = {token, value};
                    }
                    if (topic2 === userAddress) {
                        received = {token, value};
                    }
                }

                const bnbSpent = decorated.value * 0.000000000000000001;

                const tokenNameReceived = received
                    ? (contractAddresses.includes(received.token) ? received.token : received.token)
                    : "";
                const tokenNameSent = sent
                    ? (contractAddresses.includes(sent.token) ? sent.token : sent.token)
                    : "";

                let bought = {}
                let sold = {}
                let transactionType = {}
                if (bnbSpent && received) {
                    transactionType = 'buy';
                    bought = {
                        symbol: tx.token_symbol,
                        amount: tokenNameReceived,
                    }
                    sold = {
                        symbol: 'WBNB',
                        amount: -bnbSpent,
                    }
                }
                if (sent) {
                    transactionType = 'sell';
                    bought = {
                        symbol: 'WBNB',
                        amount: bnbSpent,
                    }
                    sold = {
                        symbol: tx.token_symbol,
                        amount: tokenNameSent,
                    }
                }

                const swapObject = {
                    transactionType,
                    transactionHash: tx.transaction_hash,
                    from: decorated.from_address,
                    to: decorated.to_address,
                    bought,
                    sold,
                };
                swapsArray.push(swapObject);
            } else {
                const transferObject = {
                    transactionHash: tx.transaction_hash,
                    tokenSymbol: tx.token_symbol,
                    value: tx.value,
                    contract: tx.address,
                    from: decorated.from_address,
                    to: decorated.to_address
                };
                transfersArray.push(transferObject);
            }
        }
    }

    return {lostSwaps: swapsArray, transfers: transfersArray};
}

module.exports = {checkTransactionHistory};
