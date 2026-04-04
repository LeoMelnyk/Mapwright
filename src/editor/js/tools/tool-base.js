/**
 * Base tool interface. All editor tools extend this class.
 */
export class Tool {
  /**
   * @param {string} name - Tool identifier
   * @param {string} icon - Toolbar icon character or key
   * @param {string} [cursor='crosshair'] - Default CSS cursor
   */
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
