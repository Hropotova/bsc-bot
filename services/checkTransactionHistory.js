const checkTransactionHistory = async (address, transactions, symbol, tradeSymbol, bnbPrice) => {
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

    const swapRegex = /Swapped\s+(?:(\d[\d,\.]*)\s+)?([A-Za-z0-9★ ]+?)\s+for\s+(\d[\d,\.]*)\s+([A-Za-z0-9★]+)/;

    for (const tx of transactions) {
        if (tx?.category === 'token swap') {
            const summary = tx?.summary || '';
            const match = summary.match(swapRegex);
            if (!match) {
                console.warn('Невідомий формат summary:', summary);
                continue;
            }

            // Деструктуруємо та даємо дефолти:
            const [
                _,
                rawIn = '0',           // якщо в групі 1 undefined → '0'
                symbolIn,
                rawOut = '0',          // якщо в групі 3 undefined → '0'
                symbolOut
            ] = match;

            const amountIn  = parseFloat(rawIn.replace(/,/g, ''));
            const amountOut = parseFloat(rawOut.replace(/,/g, ''));

            let transactionType, bought, sold;

            if (symbolIn === symbol) {
                transactionType = 'buy';
                bought = {
                    symbol: tx.erc20_transfers[0]?.token_symbol,
                    amount: amountOut,
                    address: tx.erc20_transfers[0]?.address,
                    pairAddress: tx.erc20_transfers[0]?.from_address,
                };
                sold = {
                    symbol: tradeSymbol,
                    amount: -amountIn,
                };

            } else if (symbolOut === symbol) {
                transactionType = 'sell';
                sold = {
                    symbol: tx.erc20_transfers[0]?.token_symbol,
                    amount: amountIn,
                    address: tx.erc20_transfers[0]?.address,
                    pairAddress: tx.erc20_transfers[0]?.to_address,
                };
                bought = {
                    symbol: tradeSymbol,
                    amount: amountOut
                };

            } else if (symbolOut === 'USDT') {
                transactionType = 'sell';
                sold = {
                    symbol: tx.erc20_transfers[0]?.token_symbol,
                    amount: amountIn,
                    address: tx.erc20_transfers[0]?.address,
                    pairAddress: tx.erc20_transfers[0]?.to_address,
                };
                bought = {
                    symbol: tradeSymbol,
                    amount: amountOut / bnbPrice
                };

            } else if (symbolIn === 'USDT') {
                transactionType = 'buy';
                bought = {
                    symbol: tx.erc20_transfers[0]?.token_symbol,
                    amount: amountOut,
                    address: tx.erc20_transfers[0]?.address,
                    pairAddress: tx.erc20_transfers[0]?.from_address,
                };
                sold = {
                    symbol: tradeSymbol,
                    amount: -(amountIn / bnbPrice),
                };
            } else {
                // якщо не входить у жодну з логік — пропускаємо
                continue;
            }

            swapsArray.push({
                transactionType,
                blockTimestamp: tx.block_timestamp,
                transactionHash: tx.hash,
                from: tx.from_address,
                to: tx.to_address,
                bought,
                sold,
            });

        } else {
            // звичайний ERC-20 трансфер
            const transfer = tx.erc20_transfers[0];
            transfersArray.push({
                transactionHash: tx.hash,
                tokenSymbol: transfer?.token_symbol,
                blockTimestamp: tx.block_timestamp,
                value: tx.value,
                contract: transfer?.address,
                from: tx.from_address,
                to: tx.to_address,
            });
        }
    }

    return {
        swaps: swapsArray,
        transfers: transfersArray,
        mismatchedContracts,
    };
};

module.exports = {checkTransactionHistory};
