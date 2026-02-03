/**
 * Tell Joke service handler.
 *
 * Provides a simple legacy handler for joke telling when not in agent mode.
 */

import { ServiceHandler, ValidationResult, ServiceContext, ServiceResult } from '../../types.js';

// Simple joke database
const jokes = {
  dad: [
    "Why don't scientists trust atoms? Because they make up everything!",
    "I told my wife she was drawing her eyebrows too high. She seemed surprised.",
    "Why don't eggs tell jokes? They'd crack each other up!",
    "I invented a new word: Plagiarism!",
    "What do you call a fake noodle? An impasta!"
  ],
  pun: [
    "I wondered why the baseball was getting bigger. Then it hit me.",
    "A bicycle can't stand on its own because it's two-tired.",
    "What do you call a bear with no teeth? A gummy bear!",
    "I used to be a banker, but I lost interest.",
    "The math teacher called in sick with algebra."
  ],
  tech: [
    "Why do programmers prefer dark mode? Because light attracts bugs!",
    "How many programmers does it take to change a light bulb? None, that's a hardware problem.",
    "Why did the developer go broke? Because he used up all his cache!",
    "There are only 10 types of people in the world: those who understand binary and those who don't.",
    "A SQL query goes into a bar, walks up to two tables and asks... 'Can I join you?'"
  ],
  general: [
    "What do you get when you cross a snowman and a vampire? Frostbite!",
    "Why did the scarecrow win an award? He was outstanding in his field!",
    "What's orange and sounds like a parrot? A carrot!",
    "Why don't some couples go to the gym? Because some relationships don't work out!",
    "What did the ocean say to the beach? Nothing, it just waved!"
  ]
};

export const tellJokeHandler: ServiceHandler = {
  /**
   * Validate joke request input.
   */
  validate(input: any): ValidationResult {
    // Allow empty input for random jokes
    if (!input) {
      return { valid: true, sanitized: {} };
    }

    if (typeof input !== 'object') {
      return { valid: false, error: 'Input must be an object or empty for random joke' };
    }

    const sanitized: any = {};

    // Validate topic if provided
    if (input.topic !== undefined) {
      if (typeof input.topic !== 'string') {
        return { valid: false, error: 'Topic must be a string' };
      }
      sanitized.topic = input.topic.toLowerCase().trim();
    }

    // Validate style if provided
    if (input.style !== undefined) {
      const validStyles = ['dad', 'pun', 'tech', 'general'];
      if (typeof input.style !== 'string' || !validStyles.includes(input.style)) {
        return {
          valid: false,
          error: `Style must be one of: ${validStyles.join(', ')}`
        };
      }
      sanitized.style = input.style;
    }

    return { valid: true, sanitized };
  },

  /**
   * Process the joke request.
   */
  async process(input: any, context: ServiceContext): Promise<ServiceResult> {
    try {
      const startTime = Date.now();

      // Determine joke style
      let style = input.style || 'general';

      // If topic is provided but no style, try to match topic to style
      if (input.topic && !input.style) {
        const topic = input.topic.toLowerCase();
        if (topic.includes('dad') || topic.includes('father')) {
          style = 'dad';
        } else if (topic.includes('pun') || topic.includes('wordplay')) {
          style = 'pun';
        } else if (topic.includes('programming') || topic.includes('tech') || topic.includes('computer')) {
          style = 'tech';
        }
      }

      // Get joke from the selected category
      const jokeCategory = jokes[style as keyof typeof jokes] || jokes.general;
      const joke = jokeCategory[Math.floor(Math.random() * jokeCategory.length)];

      const processingTime = Date.now() - startTime;

      return {
        success: true,
        data: {
          joke,
          style,
          topic: input.topic || 'random',
          timestamp: new Date().toISOString()
        },
        metadata: {
          processingTime,
          version: '1.0',
          jokeCount: jokeCategory.length,
          source: 'built-in-handler'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          serviceId: 'tell-joke',
          errorType: 'processing_error'
        }
      };
    }
  }
};