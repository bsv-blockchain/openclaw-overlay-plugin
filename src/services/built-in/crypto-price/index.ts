/**
 * Crypto Price Analysis service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const cryptoPriceService: ServiceDefinition = {
  id: 'crypto-price',
  name: 'Crypto Price Analysis',
  description: 'Real-time cryptocurrency prices, market data, and technical analysis with alerts.',
  defaultPrice: 25,
  category: ServiceCategory.RESEARCH,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Cryptocurrency symbol (e.g., BTC, ETH, BSV)',
        pattern: '^[A-Z]{3,10}$'
      },
      vs_currency: {
        type: 'string',
        description: 'Base currency for price (USD, EUR, BTC)',
        pattern: '^[A-Z]{3}$',
        default: 'USD'
      },
      analysis_type: {
        type: 'string',
        enum: ['price', 'technical', 'market_cap', 'volume', 'full'],
        description: 'Type of analysis to perform',
        default: 'price'
      },
      timeframe: {
        type: 'string',
        enum: ['1h', '24h', '7d', '30d', '1y'],
        description: 'Timeframe for analysis',
        default: '24h'
      },
      include_chart: {
        type: 'boolean',
        description: 'Include ASCII chart in response',
        default: false
      },
      alert_threshold: {
        type: 'object',
        properties: {
          price_above: { type: 'number', description: 'Alert if price goes above' },
          price_below: { type: 'number', description: 'Alert if price goes below' },
          change_above: { type: 'number', description: 'Alert if % change above' },
          change_below: { type: 'number', description: 'Alert if % change below' }
        },
        description: 'Optional price alert thresholds'
      }
    },
    required: ['symbol']
  }
};

export default cryptoPriceService;