const mergeVirtualTokens = (tokenData) => {
    const symbolGroups = {};

    for (const [address, data] of Object.entries(tokenData)) {
        const symbol = data.symbol;
        if (!symbol) continue;

        if (!symbolGroups[symbol]) symbolGroups[symbol] = [];
        symbolGroups[symbol].push({address, data});
    }

    for (const group of Object.values(symbolGroups)) {
        if (group.length <= 1) continue;

        const main = group[0].data;
        if (!main.same_contracts) main.same_contracts = {};

        for (let i = 1; i < group.length; i++) {
            const current = group[i].data;
            const currentAddress = group[i].address;

            const hasVirtual = [...(main.trades || []), ...(current.trades || [])].some(
                t => t.bought?.isVirtual || t.sold?.isVirtual
            );

            if (!hasVirtual) continue;

            main.spent += current.spent;
            main.received += current.received;
            main.balance += current.balance;
            main.trades.push(...current.trades);

            main.same_contracts[currentAddress] = {
                symbol: current.symbol
            };

            delete tokenData[currentAddress];
        }
    }

    return tokenData;
}

module.exports = {mergeVirtualTokens};
