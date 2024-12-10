const {getHoneypot} = require('../api/crypto');

const honeypotChecker = async (contract, ethereumPrice) => {
    let scam;

    try {
        const response = await getHoneypot(contract);
        if (response.simulationSuccess) {
            scam = response?.honeypotResult?.isHoneypot || response?.pair?.liquidity < ethereumPrice;
        } else {
            scam = true;
        }

        if (response?.flags.includes('EFFECTIVE_HONEYPOT_LOW_SELL_LIMIT')) {
            scam = true;
        }

    } catch (error) {
        if (error?.response && error?.response?.status === 404) {
            console.log('HONEYPOT — Pair not found for contract: ', contract);
        }
        console.log('HONEYPOT ERROR:', error?.response?.data);
    }

    return {contract, scam};
};

module.exports = {honeypotChecker};
