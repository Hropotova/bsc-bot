require('dotenv').config();
const axios = require('axios');

const getAllTransactions = async (address, chain_id) => {
    try {
        const response = await axios.get('https://api.etherscan.io/v2/api', {
            params: {
                chainid: chain_id,
                module: 'account',
                action: 'txlist',
                address: address,
                startblock: 0,
                endblock: 99999999,
                sort: 'asc',
                apikey: process.env.SCAN_API_KEY,
            }
        });

        return response.data.result;

    } catch (error) {
        console.error(`Error fetching transactions for ${address}:`, error.message);
        return null;
    }
};

module.exports = {getAllTransactions};
