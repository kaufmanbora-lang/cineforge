"use strict";

const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const APP_NAME = "CineForge Studio";
const RENDER_HELP_URL = "https://render.com/docs/blueprint-spec";

let mainWindow = null;
let setupWindow = null;
let serverProcess = null;
let localOrigin = null;
let isQuitting = false;

function configPath() {
  return path.join(app.getPath("userData"), "desktop-config.json");
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function normalizeBackendUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error("Введите URL облачного CineForge backend.");
  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("Для облачного backend требуется защищённый HTTPS URL.");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function trustedSender(event, window) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function bundledServerPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, "server", "server.js");
  return path.join(app.getAppPath(), ".next", "standalone", "server.js");
}

function appendServerLog(text) {
  try {
    fs.appendFileSync(path.join(app.getPath("logs"), "next-server.log"), text, "utf8");
  } catch {
    // Logging must never interrupt the editor or an active render.
  }
}

async function waitForLocalServer(origin, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverProcess?.exitCode !== null) throw new Error("Desktop renderer stopped during startup.");
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Desktop renderer did not become ready in time.");
}

async function startRendererServer(backendUrl) {
  const serverFile = bundledServerPath();
  if (!fs.existsSync(serverFile)) {
    throw new Error("В установке отсутствует desktop renderer. Переустановите CineForge Studio.");
  }

  const port = await findFreePort();
  localOrigin = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [serverFile], {
    cwd: path.dirname(serverFile),
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      CINEFORGE_BACKEND_URL: backendUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout?.on("data", (chunk) => appendServerLog(chunk.toString()));
  serverProcess.stderr?.on("data", (chunk) => appendServerLog(chunk.toString()));
  serverProcess.once("exit", (code, signal) => {
    appendServerLog(`\nDesktop renderer exited code=${code} signal=${signal}\n`);
    serverProcess = null;
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: "error",
        title: APP_NAME,
        message: "Локальный интерфейс CineForge остановлен.",
        detail: "Перезапустите приложение. Облачные рендеры и checkpoints продолжают работать.",
      });
    }
  });
  await waitForLocalServer(localOrigin);
}

function stopRendererServer() {
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill();
  serverProcess = null;
  localOrigin = null;
}

function installNavigationGuards(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event, url) => {
    if (!localOrigin) return event.preventDefault();
    const target = new URL(url);
    const local = new URL(localOrigin);
    if (target.origin !== local.origin) {
      event.preventDefault();
      if (target.protocol === "https:") void shell.openExternal(target.toString());
      return;
    }
    if (/\/api\/projects\/[^/]+\/downloads\//.test(target.pathname)) {
      event.preventDefault();
      window.webContents.downloadURL(target.toString());
    }
  });
}

function createApplicationMenu() {
  const template = [
    {
      label: "Файл",
      submenu: [
        {
          label: "Подключение к облаку…",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
            createSetupWindow(readConfig().backendUrl ?? "");
          },
        },
        { type: "separator" },
        { role: "quit", label: "Выход" },
      ],
    },
    {
      label: "Правка",
      submenu: [
        { role: "undo", label: "Отменить" },
        { role: "redo", label: "Повторить" },
        { type: "separator" },
        { role: "cut", label: "Вырезать" },
        { role: "copy", label: "Копировать" },
        { role: "paste", label: "Вставить" },
        { role: "selectAll", label: "Выбрать всё" },
      ],
    },
    {
      label: "Вид",
      submenu: [
        { role: "reload", label: "Обновить интерфейс" },
        { role: "togglefullscreen", label: "Полный экран" },
      ],
    },
    {
      label: "Справка",
      submenu: [
        { label: "Открыть журналы", click: () => void shell.openPath(app.getPath("logs")) },
        { label: "Документация Render", click: () => void shell.openExternal(RENDER_HELP_URL) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: "#080a0d",
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  installNavigationGuards(mainWindow);
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(`${localOrigin}/projects?desktop=1`);
}

const setupHtml = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>CineForge Studio</title><style>
:root{color-scheme:dark;font-family:Inter,"Segoe UI",sans-serif;background:#080a0d;color:#f2f4f7}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 80% 10%,rgba(27,93,92,.17),transparent 34%),#080a0d}
.shell{width:min(720px,calc(100vw - 56px));border:1px solid #262a31;background:#101318;box-shadow:0 28px 90px #000a;padding:38px}
.brand{display:flex;align-items:center;gap:12px;color:#aab1ba;font-size:12px;letter-spacing:.18em;text-transform:uppercase}.mark{width:28px;height:28px;display:grid;place-items:center;background:#e8a75d;color:#111;font-weight:800;clip-path:polygon(13% 0,100% 0,87% 100%,0 100%)}
h1{font-size:32px;line-height:1.08;margin:30px 0 12px;letter-spacing:-.035em}p{color:#969eaa;font-size:14px;line-height:1.65;margin:0 0 28px;max-width:590px}
label{display:block;color:#b5bbc4;font-size:12px;margin-bottom:9px}input{width:100%;height:48px;border:1px solid #323740;background:#0b0e12;color:#fff;padding:0 15px;font:14px ui-monospace,SFMono-Regular,Consolas,monospace;outline:none}input:focus{border-color:#d99148;box-shadow:0 0 0 3px rgba(217,145,72,.12)}
.actions{display:flex;gap:10px;margin-top:18px}button{height:42px;border:1px solid #343941;background:#171b21;color:#e8ebef;padding:0 18px;font:600 13px "Segoe UI",sans-serif;cursor:pointer}button.primary{border-color:#e4a05a;background:#e4a05a;color:#17110b}button:disabled{opacity:.55;cursor:wait}.status{min-height:22px;margin-top:16px;font-size:12px;color:#7cc4b8}.status.error{color:#f08c86}.note{margin-top:30px;border-top:1px solid #252a31;padding-top:18px;color:#6f7782;font-size:11px;line-height:1.6}
</style></head><body><main class="shell"><div class="brand"><span class="mark">CF</span>CineForge Studio · Windows</div><h1>Подключите облачную киностудию</h1><p>Интерфейс установлен на этом компьютере. Сценарии, очередь, контрольные точки, видеофайлы и рендеры хранятся в облаке и продолжают работать, когда приложение закрыто или компьютер выключен.</p><label for="backend">Адрес облачного сервера CineForge</label><input id="backend" spellcheck="false" placeholder="https://ваш-сервис.onrender.com"><div class="actions"><button class="primary" id="connect">Проверить и подключить</button><button id="help">Как развернуть сервер</button></div><div class="status" id="status"></div><div class="note">Адрес сохраняется только в профиле Windows. Ключи Google и OpenAI хранятся в защищённом серверном хранилище и никогда не встраиваются в установщик.</div></main><script>
const input=document.getElementById('backend'),status=document.getElementById('status'),connect=document.getElementById('connect');
window.cineforgeDesktop.getAppInfo().then(info=>{if(info.backendUrl)input.value=info.backendUrl});
document.getElementById('help').addEventListener('click',()=>window.cineforgeDesktop.openRenderHelp());
connect.addEventListener('click',async()=>{connect.disabled=true;status.className='status';status.textContent='Проверяю защищённое соединение…';const result=await window.cineforgeDesktop.saveBackendUrl(input.value);if(!result.ok){status.className='status error';status.textContent=result.error;connect.disabled=false}else{status.textContent='Подключено. Запускаю CineForge Studio…'}});
input.addEventListener('keydown',event=>{if(event.key==='Enter')connect.click()});
</script></body></html>`;

function createSetupWindow(initialBackendUrl = "") {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 820,
    height: 620,
    minWidth: 720,
    minHeight: 560,
    show: false,
    backgroundColor: "#080a0d",
    title: `${APP_NAME} — подключение к облаку`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  setupWindow.once("ready-to-show", () => setupWindow?.show());
  setupWindow.on("closed", () => {
    setupWindow = null;
    if (!mainWindow) app.quit();
  });
  const html = initialBackendUrl ? setupHtml.replace("placeholder=", `value=${JSON.stringify(initialBackendUrl)} placeholder=`) : setupHtml;
  void setupWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function connectAndOpen(backendUrl) {
  stopRendererServer();
  await startRendererServer(backendUrl);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  createMainWindow();
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.removeAllListeners("closed");
    setupWindow.close();
    setupWindow = null;
  }
}

ipcMain.handle("desktop:get-app-info", (event) => {
  if (!trustedSender(event, setupWindow) && !trustedSender(event, mainWindow)) return {};
  return { name: APP_NAME, version: app.getVersion(), backendUrl: readConfig().backendUrl ?? "" };
});

ipcMain.handle("desktop:open-render-help", (event) => {
  if (!trustedSender(event, setupWindow) && !trustedSender(event, mainWindow)) return false;
  void shell.openExternal(RENDER_HELP_URL);
  return true;
});

ipcMain.handle("desktop:save-backend-url", async (event, value) => {
  if (!trustedSender(event, setupWindow)) return { ok: false, error: "Недоверенный запрос." };
  try {
    const backendUrl = normalizeBackendUrl(value);
    const response = await fetch(backendUrl, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Backend ответил HTTP ${response.status}.`);
    writeConfig({ backendUrl });
    void connectAndOpen(backendUrl).catch((error) => {
      void dialog.showErrorBox(APP_NAME, error instanceof Error ? error.message : String(error));
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = mainWindow ?? setupWindow;
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });

  app.whenReady().then(async () => {
    app.setName(APP_NAME);
    app.setAppUserModelId("com.cineforge.studio");
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.on("will-download", (_event, item, webContents) => {
      item.pause();
      const parent = BrowserWindow.fromWebContents(webContents) ?? mainWindow;
      const options = {
        title: "Сохранить файл CineForge",
        defaultPath: path.join(app.getPath("downloads"), item.getFilename()),
      };
      const saveDialog = parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options);
      void saveDialog.then(({ canceled, filePath }) => {
        if (canceled || !filePath) return item.cancel();
        item.setSavePath(filePath);
        item.resume();
      });
    });
    createApplicationMenu();

    const configured = process.env.CINEFORGE_BACKEND_URL || readConfig().backendUrl;
    if (!configured) return createSetupWindow();
    try {
      await connectAndOpen(normalizeBackendUrl(configured));
    } catch (error) {
      appendServerLog(`Startup failed: ${error instanceof Error ? error.stack : String(error)}\n`);
      createSetupWindow(configured);
    }
  });
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  isQuitting = true;
  stopRendererServer();
});
