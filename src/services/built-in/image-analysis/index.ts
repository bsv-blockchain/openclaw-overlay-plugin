/**
 * Image Analysis service definition.
 */

import { ServiceDefinition, ServiceCategory } from '../../types.js';

const imageAnalysisService: ServiceDefinition = {
  id: 'image-analysis',
  name: 'Image Analysis',
  description: 'Analyze and describe images. Identify objects, text, scenes, and more.',
  defaultPrice: 30,
  category: ServiceCategory.AI,
  inputSchema: {
    type: 'object',
    properties: {
      imageUrl: { type: 'string', description: 'URL of the image to analyze' },
      imageData: { type: 'string', description: 'Base64 encoded image data' },
      analysisType: {
        type: 'string',
        enum: ['general', 'objects', 'text', 'faces', 'scenes'],
        description: 'Type of analysis to perform'
      },
      detailLevel: {
        type: 'string',
        enum: ['brief', 'detailed', 'comprehensive'],
        description: 'Level of detail in analysis'
      }
    },
    oneOf: [
      { required: ['imageUrl'] },
      { required: ['imageData'] }
    ]
  }
};

export default imageAnalysisService;