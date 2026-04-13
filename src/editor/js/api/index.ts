// Editor API Assembler
// Imports all category modules and assembles the unified api object.
// Assigns to window.editorAPI when the editor is ready.

import { _setApi, getThemeCatalog, state } from './_shared.js';

// Category modules
import * as mapManagement from './map-management.js';
import * as cells from './cells.js';
import * as wallsDoors from './walls-doors.js';
import * as labels from './labels.js';
import * as stairsBridges from './stairs-bridges.js';
import * as trims from './trims.js';
import * as fills from './fills.js';
import * as textures from './textures.js';
import * as lighting from './lighting.js';
import * as props from './props.js';
import * as spatial from './spatial.js';
import * as convenience from './convenience.js';
import * as validation from './validation.js';
import * as planBrief from './plan-brief.js';
import * as levels from './levels.js';
import * as operational from './operational.js';
import * as preview from './preview.js';
import * as inspect from './inspect.js';
import * as transforms from './transforms.js';
import * as furnish from './furnish.js';
import * as discovery from './discovery.js';
import * as vocab from './vocab.js';

// ─── Assemble ────────────────────────────────────────────────────────────────

const api = {
  // Map Management
  ...mapManagement,
  // Cell Operations & Room Creation
  ...cells,
  // Walls & Doors
  ...wallsDoors,
  // Labels
  ...labels,
  // Stairs & Bridges
  ...stairsBridges,
  // Trims
  ...trims,
  // Fills
  ...fills,
  // Textures
  ...textures,
  // Lighting
  ...lighting,
  // Props (including bulk placement)
  ...props,
  // Spatial Queries
  ...spatial,
  // Convenience
  ...convenience,
  // Validation
  ...validation,
  // Plan Brief
  ...planBrief,
  // Levels
  ...levels,
  // Operational (undo/redo, catalogs, export, eval, etc.)
  ...operational,
  // Preview
  ...preview,
  // Inspection (read-only queries)
  ...inspect,
  // Bulk transforms (clone, mirror, rotate, replace)
  ...transforms,
  // Auto-furnish (catalog-driven prop placement)
  ...furnish,
  // Discovery (apiSearch / apiDetails / apiCategories)
  ...discovery,
  // Room vocabulary library (palette-based room specs)
  ...vocab,
  // Rename eval_ back to eval (eval is a reserved word in strict mode exports)
  eval: operational.eval_,
};

// Clean up the alias — api should have 'eval' not 'eval_'
delete (api as Record<string, unknown>).eval_;

/**
 * The full editor automation API surface, derived from the assembled object.
 * Used to type `window.editorAPI` so renaming a method on the source side
 * surfaces a type error at the dispatch layer instead of failing at runtime.
 */
export type EditorAPI = Omit<typeof api, 'eval_'>;

declare global {
  interface Window {
    editorAPI?: EditorAPI;
  }
}

// Set the API reference so cross-module getApi() calls work
_setApi(api);

// ─── Wait for editor readiness, then expose ──────────────────────────────────

function waitForReady(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- catalogs load async; null until ready
      if (document.getElementById('editor-canvas') && state.dungeon && getThemeCatalog() !== null) {
        window.editorAPI = api as EditorAPI;
        console.log('[editor-api] API ready — window.editorAPI available');
        resolve();
      } else {
        requestAnimationFrame(check);
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', check);
    } else {
      check();
    }
  });
}

void waitForReady();
