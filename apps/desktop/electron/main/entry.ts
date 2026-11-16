import { app, BrowserWindow } from "electron";
import { defaultDataDir, hasSingleInstanceLock, singleInstanceRequired } from "./installation";
import { prepareStorage } from "./storage/bootstrap";
import { listenForDeepLinks } from "./bootstrap/deep-links";

// Do not top-level-await Electron readiness: module evaluation gates the ready event.
// The full composition root is imported only after offline maintenance has finished.
if (hasSingleInstanceLock) {
  let booted = false;
  // Before `ready`: macOS delivers the link that launched the app as `open-url`.
  listenForDeepLinks(app);
  app.on("second-instance", () => {
    if (booted) return;
    const window = BrowserWindow.getAllWindows()[0];
    window?.show();
    window?.focus();
  });
  void prepareStorage(defaultDataDir, !singleInstanceRequired)
    .then(() => {
      booted = true;
      return import("./index");
    })
    .catch((error: unknown) => {
      console.error("Storage startup failed", error instanceof Error ? error.message : String(error));
      app.exit(1);
    });
}
