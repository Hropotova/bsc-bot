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
        const response = await api.post(rpcUrl, {
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getCode',
            params: [address, 'latest']
        });
        console.log('is code', (response.data.result === '0x' || response.data.result === '0x0'))
        return (response.data.result === '0x' || response.data.result === '0x0');
    } catch (err) {
        console.error(`Error fetching ${chain} node:`, err);
        return null;
    }
}

module.exports = {getCode};
