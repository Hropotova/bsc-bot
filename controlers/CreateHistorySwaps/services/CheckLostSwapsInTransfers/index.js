const {getTokenTransfers} = require('../../../../api/scan');
const {getWalletTokenSwaps} = require('../../../../api/moralis');

const checkLostSwapsInTransfers = async (config, address, swapsArray, transfersArray) => {
    const swaps = await getWalletTokenSwaps(address, config.chain);

    const existingSwapHashes = new Set(swapsArray.map(s => s.transactionHash.toLowerCase()));
    const swapHashes = new Set(swaps.map(s => s.transactionHash.toLowerCase()));

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
            const boughtTransfers = await getTokenTransfers(address, boughtAddress, config.chain_id);
            if (Array.isArray(boughtTransfers) && boughtTransfers.length > 0) {
                shouldAdd = true;
            }
        }

        if (!shouldAdd && !isSoldSafe) {
            const soldTransfers = await getTokenTransfers(address, soldAddress, config.chain_id);
            if (Array.isArray(soldTransfers) && soldTransfers.length > 0) {
                shouldAdd = true;
            }
        }

        if (shouldAdd) {
            validatedSwaps.push(swap);
        }
    }

    const allSwaps = [...swapsArray, ...validatedSwaps];

    const uniqueSwapsMap = new Map();

    for (const swap of allSwaps) {
        const hash = swap.transactionHash.toLowerCase();

        const hasWETH =
            swap?.bought?.symbol?.toUpperCase() === config.trade_symbol ||
            swap?.sold?.symbol?.toUpperCase() === config.trade_symbol;

        if (!uniqueSwapsMap.has(hash)) {
            uniqueSwapsMap.set(hash, hasWETH ? swap : null);
        } else if (hasWETH) {
            uniqueSwapsMap.set(hash, swap);
        }
    }

    const deduplicatedSwaps = Array.from(uniqueSwapsMap.values()).filter(Boolean);

    return {
        swaps: deduplicatedSwaps,
        transfers: filteredTransfers
    };
};

module.exports = {checkLostSwapsInTransfers};
