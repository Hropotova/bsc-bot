const associatedAddresses = (address, transactions) => {
    const inboundMap = {};
    const outboundMap = {};

    transactions.forEach(tx => {
        const category = (tx.category || '').toLowerCase();

        if (category.includes('send') && tx.from_address?.toLowerCase() === address.toLowerCase()) {
            const counterparty = tx.to_address?.toLowerCase();
            if (!counterparty) return;
            outboundMap[counterparty] = (outboundMap[counterparty] || 0) + 1;
        } else if (category.includes('receive') && tx.to_address?.toLowerCase() === address.toLowerCase()) {
            const counterparty = tx.from_address?.toLowerCase();
            if (!counterparty) return;
            inboundMap[counterparty] = (inboundMap[counterparty] || 0) + 1;
        }
    });

    const inbound = Object.entries(inboundMap).map(
        ([addr, count]) => ({address: addr, count})
    );

    const outbound = Object.entries(outboundMap).map(
        ([addr, count]) => ({address: addr, count})
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
