const checkTransactionHistory = async (address, transactions, symbol, tradeSymbol, bnbPrice) => {
    const swapsArray = [];
    const transfersArray = [];

    const swapRegex = /^Swapped\s+(?:(\d[\d.,]*|NaN)\s+)?(.+?)\s+for\s+(\d[\d.,]*|NaN)\s+(.+?)(?:\s+and\s+(\d[\d.,]*|NaN)\s+(.+))?$/;
    for (const tx of transactions) {
        if (tx.category === 'token swap') {
            const m = tx.summary.match(swapRegex);
            if (!m) continue;
            const [, rawIn='0', symbolIn, rawOut1='0', symbolOut1, rawOut2='0', symbolOut2] = m;
            const amountIn = parseFloat(rawIn.replace(/,/g,'')) || 0;
            let rawOut = rawOut1, symbolOut = symbolOut1;
            if (symbolOut2 === 'BNB') {
                rawOut = rawOut2;
                symbolOut = symbolOut2;
            }
            const amountOut = parseFloat(rawOut.replace(/,/g,'')) || 0;
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
                    pairAddress: tx.erc20_transfers[0]?.from_address,
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
                    pairAddress: tx.erc20_transfers[0]?.to_address,
                    symbol: tradeSymbol,
                    amount: amountOut
                };

            } else if (symbolOut === 'USDT') {
                transactionType = 'sell';
                sold = {
                    symbol: symbolIn,
                    amount: amountIn,
                    address: tx.erc20_transfers.filter(i => i.token_symbol === symbolIn)[0]?.address,
                    pairAddress: tx.erc20_transfers.filter(i => i.token_symbol === symbolIn)[0]?.to_address,
                };
                bought = {
                    pairAddress: tx.erc20_transfers.filter(i => i.token_symbol === symbolOut)[0]?.to_address,
                    symbol: tradeSymbol,
                    amount: amountOut / bnbPrice
                };

            } else if (symbolIn === 'USDT') {
                transactionType = 'buy';
                bought = {
                    symbol: symbolOut,
                    amount: amountOut,
                    address: tx.erc20_transfers.filter(i => i.token_symbol === symbolOut)[0]?.address,
                    pairAddress: tx.erc20_transfers.filter(i => i.token_symbol === symbolOut)[0]?.from_address,
                };
                sold = {
                    pairAddress: tx.erc20_transfers.filter(i => i.token_symbol === symbolOut)[0]?.from_address,
                    symbol: tradeSymbol,
                    amount: -(amountIn / bnbPrice),
                };

            } else if (symbolOut === tradeSymbol) {
                transactionType = 'sell';
                sold = {
                    symbol: tx.erc20_transfers[0]?.token_symbol,
                    amount: amountIn,
                    address: tx.erc20_transfers[0]?.address,
                    pairAddress: tx.erc20_transfers[0]?.to_address,
                };
                bought = {
                    pairAddress: tx.erc20_transfers[0]?.to_address,
                    symbol: tradeSymbol,
                    amount: amountOut,
                };
            } else if (symbolIn === tradeSymbol) {
                transactionType = 'buy';
                bought = {
                    symbol: tx.erc20_transfers[0]?.token_symbol,
                    amount: amountOut,
                    address: tx.erc20_transfers[0]?.address,
                    pairAddress: tx.erc20_transfers[0]?.from_address,
                };
                sold = {
                    pairAddress: tx.erc20_transfers[0]?.from_address,
                    symbol: tradeSymbol,
                    amount: -amountIn,
                };
            }else {
                continue;
            }

            swapsArray.push({
                transactionType,
                blockTimestamp: tx.block_timestamp,
                transactionHash: tx.hash,
                from: tx.from_address,
                to: tx.to_address,
                summary: tx.summary,
                category: tx.category,
                bought,
                sold,
            });

        } else if (tx.category === 'send' || tx.category === 'receive' || tx.category === 'token send' || tx.category === 'token receive') {
            const transfer = tx.erc20_transfers[0];
            transfersArray.push({
                transactionHash: tx.hash,
                tokenSymbol: transfer?.token_symbol,
                blockTimestamp: tx.block_timestamp,
                value: tx.value,
                contract: transfer?.address,
                summary: tx.summary,
                category: tx.category,
                from: tx.from_address,
                to: tx.to_address,
            });
        }
    }

    return {
        swaps: swapsArray,
        transfers: transfersArray,
    };
};

module.exports = {checkTransactionHistory};
