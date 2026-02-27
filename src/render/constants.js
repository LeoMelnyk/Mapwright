// Constants
const GRID_SCALE = 10; // pixels per foot
const MARGIN = 50; // pixels around the dungeon
const LINE_WIDTH = 6; // Thick walls to match SimpleDungeonMap.jpg

// Z-position constants for coordinate system
const Z_POSITIONS = {
  TOP_LEFT: 0,
  TOP_CENTER: 1,
  TOP_RIGHT: 2,
  RIGHT_CENTER: 3,
  BOTTOM_RIGHT: 4,
  BOTTOM_CENTER: 5,
  BOTTOM_LEFT: 6,
  LEFT_CENTER: 7,
  CENTER: 8
};

export { GRID_SCALE, MARGIN, LINE_WIDTH, Z_POSITIONS };
