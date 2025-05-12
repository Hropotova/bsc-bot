const checkTransactionHistory = async (address, transactions, symbol, tradeSymbol, chain) => {
    const swapsArray = [];
    const transfersArray = [];

    const mismatchedTransfers = transactions.filter(tx =>
        tx?.from_address.toLowerCase() !== address.toLowerCase() &&
        Array.isArray(tx?.erc20_transfers) &&
        tx?.erc20_transfers.length > 0
    );
    const mismatchedContracts = Array.from(new Set(
        mismatchedTransfers.map(tx => tx?.erc20_transfers[0].address.toLowerCase())
    ));

    const swapRegex = /Swapped\s+([\d,\.]+)\s+\$?([A-Za-z0-9_]+)\s+for\s+([\d,\.]+)\s+\$?([A-Za-z0-9_]+)/;

    for (const tx of transactions) {
        if (tx?.category === 'token swap') {
            const summary = tx?.summary;
            const match = summary.match(swapRegex);
            if (!match) {
                console.warn('Невідомий формат summary:', summary);
                continue;
            }

            const amountIn = parseFloat(match[1].replace(/,/g, ''));
            const symbolIn = match[2];
            const amountOut = parseFloat(match[3].replace(/,/g, ''));
            const symbolOut = match[4];

            let transactionType, bought, sold;

            if (symbolIn === symbol) {
                transactionType = 'buy';
                bought = {
                    symbol: tx?.erc20_transfers[0]?.token_symbol,
                    amount: amountIn,
                    address: tx?.erc20_transfers[0]?.address,
                    pairAddress: tx?.erc20_transfers[0]?.from_address,
                };
                sold = {
                    symbol: tradeSymbol,
                    amount: -amountIn,
                };
            } else if (symbolOut === symbol) {
                transactionType = 'sell';
                sold = {
                    symbol: tx?.erc20_transfers[0]?.token_symbol,
                    amount: amountOut,
                    address: tx?.erc20_transfers[0]?.address,
                    pairAddress: tx?.erc20_transfers[0]?.to_address,
                };
                bought = {
                    symbol: tradeSymbol,
                    amount: amountOut
                };
            }

            swapsArray.push({
                transactionType,
                blockTimestamp: tx?.block_timestamp,
                transactionHash: tx?.hash,
                from: tx?.from_address,
                to: tx?.to_address,
                bought,
                sold,
            });

        } else {
            const transfer = tx?.erc20_transfers[0];
            transfersArray.push({
                transactionHash: tx?.hash,
                tokenSymbol: transfer?.token_symbol,
                blockTimestamp: tx?.block_timestamp,
                value: tx?.value,
                contract: transfer?.address,
                from: tx?.from_address,
                to: tx?.to_address,
            });
        }
    }
    console.log('swapsArray', swapsArray)
    return {
        swaps: swapsArray,
        transfers: transfersArray,
        mismatchedContracts,
    };
};

module.exports = {checkTransactionHistory};
