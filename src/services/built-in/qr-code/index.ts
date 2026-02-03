/**
 * QR Code Generator service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const qrCodeService: ServiceDefinition = {
  id: 'qr-code',
  name: 'QR Code Generator',
  description: 'Generate QR codes for text, URLs, contact info, WiFi credentials, and more.',
  defaultPrice: 8,
  category: ServiceCategory.UTILITY,
  inputSchema: {
    type: 'object',
    properties: {
      data: {
        type: 'string',
        description: 'Data to encode in the QR code',
        maxLength: 2000
      },
      type: {
        type: 'string',
        enum: ['text', 'url', 'email', 'phone', 'sms', 'wifi', 'vcard'],
        description: 'Type of QR code to generate',
        default: 'text'
      },
      size: {
        type: 'number',
        description: 'QR code size in pixels',
        minimum: 100,
        maximum: 1000,
        default: 300
      },
      errorCorrection: {
        type: 'string',
        enum: ['L', 'M', 'Q', 'H'],
        description: 'Error correction level (L=7%, M=15%, Q=25%, H=30%)',
        default: 'M'
      },
      format: {
        type: 'string',
        enum: ['png', 'svg', 'dataurl'],
        description: 'Output format',
        default: 'png'
      },
      foregroundColor: {
        type: 'string',
        description: 'Foreground color (hex)',
        pattern: '^#[0-9A-Fa-f]{6}$',
        default: '#000000'
      },
      backgroundColor: {
        type: 'string',
        description: 'Background color (hex)',
        pattern: '^#[0-9A-Fa-f]{6}$',
        default: '#ffffff'
      }
    },
    required: ['data']
  }
};

export default qrCodeService;