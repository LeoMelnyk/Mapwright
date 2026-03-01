// Base tool interface
export class Tool {
  constructor(name, icon, cursor = 'crosshair') {
    this.name = name;
    this.icon = icon;
    this.cursor = cursor;
  }

  onActivate() {}
  onDeactivate() {}
  onMouseDown(_row, _col, _edge, _event, _pos) {}
  onMouseMove(_row, _col, _edge, _event, _pos) {}
  onMouseUp(_row, _col, _edge, _event, _pos) {}
  onKeyDown(_event) {}
  onRightClick(_row, _col, _edge, _event) {}
  getCursor() { return this.cursor; }
  renderOverlay(_ctx, _transform, _gridSize) {}
}
