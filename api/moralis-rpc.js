require('dotenv').config();
const axios = require('axios');

const api = axios.create({
    headers: {
        accept: 'application/json',
        'Content-Type': 'application/json',
    }
});

const getCode = async (address, rpcUrl, chain) => {
    try {
        console.log(`Moralis: Fetching check code if contract for ${address}`);
        const response = await api.post(rpcUrl, {
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getCode',
            params: [address, 'latest']
        });
        console.log(`Moralis: Fetched check code if contract for ${address}`);
        return response.data.result;
    } catch (err) {
        console.error(`Error fetching ${chain} node:`, err);
        return null;
    }
}

module.exports = {getCode};
