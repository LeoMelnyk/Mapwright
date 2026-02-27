// Base tool interface
export class Tool {
  constructor(name, icon, cursor = 'crosshair') {
    this.name = name;
    this.icon = icon;
    this.cursor = cursor;
  }

  onActivate() {}
  onDeactivate() {}
  onMouseDown(row, col, edge, event, pos) {}
  onMouseMove(row, col, edge, event, pos) {}
  onMouseUp(row, col, edge, event, pos) {}
  onKeyDown(event) {}
  onRightClick(row, col, edge, event) {}
  getCursor() { return this.cursor; }
  renderOverlay(ctx, transform, gridSize) {}
}
