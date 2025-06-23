require('dotenv').config();
const axios = require('axios');

const api = axios.create({
    baseURL: 'https://api.etherscan.io/v2/api',
});

// Scan API to retrieve all transactions for a given address on a specific chain.
const getAllTransactions = async (address, chain_id) => {
    try {
        const response = await api.get('', {
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
        return [];
    }
};

// Scan API to retrieve all transactions for a given address on a specific chain.
const getTokenTransfers = async (address, contractAddress, chain_id) => {
    try {
        const response = await api.get('', {
            params: {
                chainid: chain_id,
                module: 'account',
                action: 'tokentx',
                address: address,
                contractaddress: contractAddress,
                startblock: 0,
                endblock: 99999999,
                sort: 'asc',
                apikey: process.env.SCAN_API_KEY,
            }
        });
        return response.data.result;
    } catch (error) {
        console.error(`Error fetching token transfers for ${address} (token: ${contractAddress}):`, error.message);
        return [];
    }
};


module.exports = {getAllTransactions, getTokenTransfers};
