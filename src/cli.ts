#!/usr/bin/env node
/**
 * BSV Overlay CLI - Bootstrap Entry Point
 *
 * Sets environment variables before importing the main CLI module
 * to suppress dotenv v17 verbose logging.
 */

// Must be set before any imports that might load dotenv
process.env.DOTENV_CONFIG_QUIET = 'true';

// Dynamic import to ensure env var is set first
import('./cli-main.js');
