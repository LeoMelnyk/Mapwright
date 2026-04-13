// Player-side state for the player view.

import type { Dungeon, Theme, PropCatalog, TextureCatalog } from '../types.js';

export interface OpenedDoor {
  row: number;
  col: number;
  dir: string;
  wasSecret?: boolean;
}

export interface PlayerState {
  // Dungeon data (received from DM)
  dungeon: Dungeon | null;
  resolvedTheme: Theme | null;  // Theme object sent by DM (avoids THEMES lookup)
  renderQuality: number;

  // Fog of war
  revealedCells: Set<string>;   // Set of "row,col" strings
  openedDoors: OpenedDoor[];    // [{ row, col, dir, wasSecret }]
  openedStairs: number[];       // [stairId, ...] — both ends pushed when a pair is opened

  // Player viewport
  panX: number;
  panY: number;
  zoom: number;

  // DM's viewport (for follow/resync)
  dmPanX: number;
  dmPanY: number;
  dmZoom: number;
  followDM: boolean;

  // Catalogs (loaded at init)
  propCatalog: PropCatalog | null;
  textureCatalog: TextureCatalog | null;
  texturesVersion: number;

  // Connection status
  connected: boolean;
}

const playerState: PlayerState = {
  // Dungeon data (received from DM)
  dungeon: null,
  resolvedTheme: null,
  renderQuality: 20,

  // Fog of war
  revealedCells: new Set(),
  openedDoors: [],
  openedStairs: [],

  // Player viewport
  panX: 0,
  panY: 0,
  zoom: 1.0,

  // DM's viewport (for follow/resync)
  dmPanX: 0,
  dmPanY: 0,
  dmZoom: 1.0,
  followDM: true,

  // Catalogs (loaded at init)
  propCatalog: null,
  textureCatalog: null,
  texturesVersion: 0,

  // Connection status
  connected: false,
};

export default playerState;
