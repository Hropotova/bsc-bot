const associatedAddresses = (address, transactions, cfg) => {
    const counterMap = {};

    function formatUnitsManual(value, decimals = 18) {
        let s = value.toString();

        if (s.length <= decimals) {
            s = s.padStart(decimals + 1, '0');
        }

        const intPart = s.slice(0, s.length - decimals);
        let fracPart = s.slice(s.length - decimals);

        fracPart = fracPart.replace(/0+$/, '');

        return `${intPart}${fracPart ? '.' + fracPart : ''}`;
    }

    transactions.forEach(tx => {
        const value = formatUnitsManual(tx.value);

        if (Number(value) > cfg.min_transfer && tx.receipt_status === '1') {
            const category = (tx.category || '').toLowerCase();

            const from = tx.erc20_transfers.length > 0
                ? tx.erc20_transfers[0].from_address
                : tx.from_address;
            const to = tx.erc20_transfers.length > 0
                ? tx.erc20_transfers[0].to_address
                : tx.to_address;

            if (category.includes('send') && from?.toLowerCase() === address.toLowerCase()) {
                const counterparty = to?.toLowerCase();
                if (!counterparty) return;

                if (!counterMap[counterparty]) {
                    counterMap[counterparty] = {direction: 'out', count: 0};
                }

                if (counterMap[counterparty].direction === 'in') {
                    counterMap[counterparty].direction = 'both';
                }
                counterMap[counterparty].count++;
            } else if (category.includes('receive') && to?.toLowerCase() === address.toLowerCase()) {
                const counterparty = from?.toLowerCase();
                if (!counterparty) return;

                if (!counterMap[counterparty]) {
                    counterMap[counterparty] = {direction: 'in', count: 0};
                }

                if (counterMap[counterparty].direction === 'out') {
                    counterMap[counterparty].direction = 'both';
                }
                counterMap[counterparty].count++;
            }
        }
    });

    const associated_addresses = Object.entries(counterMap).map(([addr, data]) => {
        const item = {
            address: addr,
            direction: data.direction
        };
        if (data.count > 1) {
            item.tx_count = data.count;
        }
        return item;
    });

    return {associated_addresses};
};

module.exports = {associatedAddresses};
