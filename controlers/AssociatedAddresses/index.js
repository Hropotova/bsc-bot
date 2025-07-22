const associatedAddresses = (address, transactions, cfg) => {
    const inboundMap = {};
    const outboundMap = {};

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
        const value = formatUnitsManual(tx.value)


        if (Number(value) > cfg.min_transfer && tx.receipt_status === '1') {

            const category = (tx.category || '').toLowerCase();

            const from = tx.erc20_transfers.length > 0 ? tx.erc20_transfers[0].from_address : tx.from_address;
            const to = tx.erc20_transfers.length > 0 ? tx.erc20_transfers[0].to_address : tx.to_address;

            if (category.includes('send') && from?.toLowerCase() === address.toLowerCase()) {
                const counterparty = to?.toLowerCase();
                if (!counterparty) return;
                outboundMap[counterparty] = (outboundMap[counterparty] || 0) + 1;
            } else if (category.includes('receive') && to?.toLowerCase() === address.toLowerCase()) {
                const counterparty = from?.toLowerCase();
                if (!counterparty) return;
                inboundMap[counterparty] = (inboundMap[counterparty] || 0) + 1;
            }
        }
    });

    const inbound = Object.entries(inboundMap).map(
        ([wallet, count]) => ({address: wallet?.toLowerCase(), count})
    );

    const outbound = Object.entries(outboundMap).map(
        ([wallet, count]) => ({address: wallet?.toLowerCase(), count})
    );

    return {
        associated_addresses: {
            inbound,
            outbound,
            unique_inflow_count: inbound.length,
            unique_outflow_count: outbound.length
        }
    };
};

module.exports = {associatedAddresses};
