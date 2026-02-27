// Player-side state for the player view.

const playerState = {
  // Dungeon data (received from DM)
  dungeon: null,
  resolvedTheme: null,  // Theme object sent by DM (avoids THEMES lookup)

  // Fog of war
  revealedCells: new Set(),   // Set of "row,col" strings
  openedDoors: [],            // [{ row, col, dir, wasSecret }]
  openedStairs: [],           // [stairId, ...] — both ends pushed when a pair is opened

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
