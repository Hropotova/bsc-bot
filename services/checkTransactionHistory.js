const {decodeTransaction, getWalletHistory} = require('../api/moralis');

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

    // Get the full transaction history of a specified wallet address.
    const transactions = await getWalletHistory(address);

    // Filter spam token and transactions
    const ercTransfers = transactions.filter(i => i.from_address.toLowerCase() === address.toLowerCase() && i.erc20_transfers.length !== 0);

    // Check missing transactions
    const swapHashes = new Set(swaps.map((s) => s.transactionHash.toLowerCase()));
    const missingTransfers = ercTransfers.filter(
        (tx) => !swapHashes.has(tx.hash.toLowerCase())
    );

    const swapsArray = [];
    const transfersArray = [];

    for (const [i, tx] of missingTransfers.entries()) {

        const decorated = await decodeTransaction(tx.hash);
        if (decorated) {

            if (tx.category === 'token swap') {
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
                        symbol: tx.erc20_transfers[0].token_symbol,
                        amount: tokenNameReceived,
                        address: tx.erc20_transfers[0].address,
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
                        symbol: tx.erc20_transfers[0].token_symbol,
                        amount: tokenNameSent,
                        address: tx.erc20_transfers[0].address,
                    }
                }

                const swapObject = {
                    transactionType,
                    transactionHash: tx.hash,
                    from: decorated.from_address,
                    to: decorated.to_address,
                    bought,
                    sold,
                };
                swapsArray.push(swapObject);
            } else {
                const transferObject = {
                    transactionHash: tx.hash,
                    tokenSymbol: tx.erc20_transfers[0].token_symbol,
                    value: tx.value,
                    contract: tx.erc20_transfers[0].address,
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
