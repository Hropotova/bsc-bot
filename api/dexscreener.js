require('dotenv').config();
const axios = require('axios');

const api = axios.create({
    baseURL: 'https://api.dexscreener.com/',
    headers: {'Accept': '*/*'},
});

const getDexscreenerTokenPrice = async (tokenAddress, chainId) => {
    const url = `token-pairs/v1/${chainId}/${tokenAddress}`;
    try {
        console.log(`Dexscreener: Fetching price data for ${tokenAddress}`);
        const response = await api.get(url);
        console.log(`Dexscreener: Fetched price data for ${tokenAddress}`);
        return response.data;
    } catch (error) {
        console.error(`Error fetching dexscreener price data`, error);
        return null;
    }
};

module.exports = {getDexscreenerTokenPrice};
