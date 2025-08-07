const {getTokenTransfers} = require('../../../../api/scan');
const {getWalletTokenSwaps} = require('../../../../api/moralis');

const checkLostSwapsInTransfers = async (config, address, swapsArray, transfersArray, nativeTokenPrice) => {
    const rawSwaps = await getWalletTokenSwaps(address, config.chain);

    const grouped = rawSwaps.reduce((acc, swap) => {
        const h = swap.transactionHash.toLowerCase();
        if (!acc[h]) acc[h] = [];
        acc[h].push(swap);
        return acc;
    }, {});

    const swaps = Object.values(grouped).map(group => {
        const tradeSwap = group.find(s =>
            s.bought?.symbol === config.trade_symbol ||
            s.sold?.symbol === config.trade_symbol
        );

        const chosen = tradeSwap || group[0];

        if (tradeSwap) {
            ['bought', 'sold'].forEach(side => {
                if (chosen[side]?.symbol === config.trade_symbol) {
                    chosen[side].symbol = config.symbol;
                }
            });
        }

        ['bought', 'sold'].forEach(side => {
            const token = chosen[side];
            const otherToken = chosen[side];

            const isStable = config.stable_coins.includes(token.address.toLowerCase());
            const isOtherToken = otherToken?.symbol !== config.trade_symbol;

            if (isStable && isOtherToken) {
                token.symbol = config.symbol;

                if (token.amount && nativeTokenPrice) {
                    token.amount = parseFloat(token.amount) / parseFloat(nativeTokenPrice);
                }
            }
        });

        return chosen;
    });

    const existingSwapHashes = new Set(
        swapsArray.map(s => s.transactionHash.toLowerCase())
    );
    const swapHashes = new Set(
        swaps.map(s => s.transactionHash.toLowerCase())
    );

    const filteredTransfers = transfersArray.filter(
        tx => !swapHashes.has(tx.transactionHash.toLowerCase())
    );

    const validatedSwaps = [];

    for (const swap of swaps) {
        const hash = swap.transactionHash.toLowerCase();
        if (existingSwapHashes.has(hash)) continue;

        const {bought, sold} = swap;

        const boughtAddress = bought.address.toLowerCase();
        const soldAddress = sold.address.toLowerCase();

        const isBoughtSafe =
            config.contract.includes(boughtAddress) ||
            config.stable_coins.includes(boughtAddress) ||
            config.excluded_contracts.includes(boughtAddress);

        const isSoldSafe =
            config.contract.includes(soldAddress) ||
            config.stable_coins.includes(soldAddress) ||
            config.excluded_contracts.includes(soldAddress);

        if (isBoughtSafe && isSoldSafe) continue;

        let shouldAdd = false;

        if (!isBoughtSafe) {
            const block = Number(swap.blockNumber);
            const boughtTransfers = await getTokenTransfers(
                address,
                boughtAddress,
                config.chain_id,
                block,
                block
            );
            if (Array.isArray(boughtTransfers) && boughtTransfers.length > 0) {
                shouldAdd = true;
            }
        }

        if (!shouldAdd && !isSoldSafe) {
            const block = Number(swap.blockNumber);
            const soldTransfers = await getTokenTransfers(
                address,
                soldAddress,
                config.chain_id,
                block,
                block
            );
            if (Array.isArray(soldTransfers) && soldTransfers.length > 0) {
                shouldAdd = true;
            }
        }

        if (shouldAdd) {
            validatedSwaps.push(swap);
        }
    }

    const updatedSwapsArray = [...swapsArray, ...validatedSwaps];
    return {
        swaps: updatedSwapsArray,
        transfers: filteredTransfers
    };
};

module.exports = {checkLostSwapsInTransfers};
