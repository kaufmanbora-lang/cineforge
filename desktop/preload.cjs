"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cineforgeDesktop", {
  isDesktop: true,
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke("desktop:get-app-info"),
  saveBackendUrl: (backendUrl) => ipcRenderer.invoke("desktop:save-backend-url", backendUrl),
  openRenderHelp: () => ipcRenderer.invoke("desktop:open-render-help"),
});
