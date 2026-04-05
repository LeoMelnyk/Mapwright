/**
 * Base tool interface. All editor tools extend this class.
 */

import type { RenderTransform } from '../../../types.js';

export interface EdgeInfo {
  row: number;
  col: number;
  direction: string;
}

export interface CanvasPos {
  x: number;
  y: number;
}

export class Tool {
  name: string;
  icon: string;
  cursor: string;

  constructor(name: string, icon: string, cursor: string = 'crosshair') {
    this.name = name;
    this.icon = icon;
    this.cursor = cursor;
  }

  onActivate(): void {}
  onDeactivate(): void {}
  onMouseDown(_row?: number, _col?: number, _edge?: EdgeInfo | null, _event?: MouseEvent | null, _pos?: CanvasPos | null): void {}
  onMouseMove(_row?: number, _col?: number, _edge?: EdgeInfo | null, _event?: MouseEvent | null, _pos?: CanvasPos | null): void {}
  onMouseUp(_row?: number, _col?: number, _edge?: EdgeInfo | null, _event?: MouseEvent | null): void {}
  onKeyDown(_event?: KeyboardEvent): void {}
  onWheel(_event?: WheelEvent): void {}
  onRightClick(_row?: number, _col?: number, _edge?: EdgeInfo | null): void {}
  getCursor(): string { return this.cursor; }
  renderOverlay(_ctx?: CanvasRenderingContext2D, _transform?: RenderTransform, _gridSize?: number): void {}
}
