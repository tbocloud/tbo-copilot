/**
 * TBO Theme only contributes CSS (manifest `contributes.themes`), so the
 * plugin process has nothing to do. The host still requires an entry module.
 */
module.exports = {
  async onLoad() {},
  async onUnload() {},
};
