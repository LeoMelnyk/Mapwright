/**
 * Gobo registry — pure data store, no I/O. The render layer reads from this
 * registry when projecting gobos; callers (editor / Node CLI) populate it
 * after loading their respective catalogs. This keeps `render/` free of the
 * `fetch`/`localStorage` dependencies that live in `editor/js/gobo-catalog.ts`.
 */

import type { GoboDefinition } from '../types.js';

const registry = new Map<string, GoboDefinition>();

/** Register every gobo definition from a catalog. Call after catalog load. */
export function setGoboDefinitions(defs: GoboDefinition[] | Record<string, GoboDefinition | undefined>): void {
  registry.clear();
  if (Array.isArray(defs)) {
    for (const d of defs) registry.set(d.id, d);
  } else {
    for (const [id, d] of Object.entries(defs)) {
      if (d) registry.set(id, d);
    }
  }
}

/** Resolve a gobo id. Returns null when the id isn't registered (e.g. CLI with no catalog loaded). */
export function getGoboDefinition(id: string): GoboDefinition | null {
  return registry.get(id) ?? null;
}
