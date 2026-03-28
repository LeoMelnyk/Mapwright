// Base tool interface
export class Tool {
  constructor(name, icon, cursor = 'crosshair') {
    this.name = name;
    this.icon = icon;
    this.cursor = cursor;
  }

  onActivate() {}
  onDeactivate() {}
  onMouseDown() {}
  onMouseMove() {}
  onMouseUp() {}
  onKeyDown() {}
  onWheel() {}
  onRightClick() {}
  getCursor() { return this.cursor; }
  renderOverlay() {}
}
