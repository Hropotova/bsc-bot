require('dotenv').config();
const axios = require('axios');

async function getEthereumPrice() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: {
                ids: 'ethereum',
                vs_currencies: 'usd'
            }
        });
        return response.data.ethereum.usd;
    } catch (error) {
        console.error('Error fetching Ethereum price:', error);
        throw error;
    }
}

async function getTokenPrice(contract) {
    try {
        const response = await axios.get(
            `https://public-api.birdeye.so/defi/price?include_liquidity=true&address=${contract}`,
            {
                headers: {
                    'x-chain': 'bsc',
                    'X-API-KEY': process.env.BIRDEYE_API_KEY
                }
            },
        );

        return response?.data?.data?.value;
    } catch (error) {
        console.error('Error fetching token price:', error);
        throw error;
    }
}

async function getHoneypot(address) {
    try {
        const response = await axios.get('https://api.honeypot.is/v2/IsHoneypot', {
            params: {
                address,
            },
            headers: {
                'X-API-KEY': process.env.HONEYPOT_API_KEY
            }
        });

        return response.data;
    } catch (error) {
        throw error;
    }
}

async function getWalletBalance(address) {
    try {
        const response = await axios.get(
            `https://public-api.birdeye.so/v1/wallet/token_list?wallet=${address}`,
            {
                headers: {
                    'x-chain': 'bsc',
                    'X-API-KEY': process.env.BIRDEYE_API_KEY,
                }
            },
        );
        return response?.data?.data?.items;
    } catch (error) {
        console.error('Error fetching token balance:', error.message);
        throw error;
    }
}

module.exports = {getEthereumPrice, getTokenPrice, getHoneypot, getWalletBalance};
