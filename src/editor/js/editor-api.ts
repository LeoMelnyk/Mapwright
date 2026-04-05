// Editor Automation API
// Loaded conditionally when ?api query param is present.
// Exposes window.editorAPI for programmatic control via Puppeteer.
//
// Split into modules under ./api/ — this file just loads the assembler.
import './api/index.js';
