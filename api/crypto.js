require('dotenv').config();
const axios = require('axios');

const getChainPrice = async () => {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: {
                ids: 'binancecoin',
                vs_currencies: 'usd'
            }
        });
        return response.data.binancecoin.usd;
    } catch (error) {
        console.error('Error fetching Ethereum price:', error);
        throw error;
    }
}

module.exports = {getChainPrice};
