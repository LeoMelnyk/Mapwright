// DM session shared state and send helper — imported by all dm-session sub-modules.

export const sessionState: {
  active: boolean;
  ws: WebSocket | null;
  token: string | null;
  revealedCells: Set<string>;
  openedDoors: { row: number; col: number; dir: string; wasSecret: boolean }[];
  openedStairs: (string | number)[];
  startingRoom: string | null;
  playerCount: number;
  dmViewActive: boolean;
  dmViewForced: boolean;
} = {
  active: false,
  ws: null,
  token: null,
  revealedCells: new Set(),
  openedDoors: [],
  openedStairs: [],
  startingRoom: null,
  playerCount: 0,
  dmViewActive: false,
  dmViewForced: false,
};

export function send(msg: unknown) {
  if (sessionState.ws?.readyState === 1) {
    sessionState.ws.send(JSON.stringify(msg));
  }
}
