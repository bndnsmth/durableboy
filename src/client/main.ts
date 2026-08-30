import { isConsoleId } from "../shared/id";
import {
  Button,
  decodeFrame,
  unpackFrameRgba,
  type ConsoleStatus,
  type ServerMessage,
} from "../shared/protocol";
import { inspectRom } from "../shared/rom";
import "./styles.css";

const STORAGE_CONSOLES = "durableboy.consoles.v1";
const STORAGE_CLIENT = "durableboy.client";
const LEGACY_STORAGE_CONSOLE = "durableboy.console";
const ADVANCE_FRAMES = 2;
const FRAME_INTERVAL_MS = (1_000 / 59.7275) * ADVANCE_FRAMES;

interface RecentConsole {
  id: string;
  model: "DMG" | "CGB";
  title: string | null;
  ownerToken?: string;
  lastOpened: number;
}

interface CreateConsoleResponse {
  status: ConsoleStatus;
  ownerToken: string;
}

const canvas = element<HTMLCanvasElement>("game-screen");
const context = requireCanvasContext(canvas);
context.imageSmoothingEnabled = false;

let recentConsoles = loadRecentConsoles();
const requestedConsole = new URL(location.href).searchParams.get("console");
const legacyConsole = localStorage.getItem(LEGACY_STORAGE_CONSOLE);
let consoleId =
  requestedConsole && isConsoleId(requestedConsole)
    ? requestedConsole
    : legacyConsole && isConsoleId(legacyConsole)
      ? legacyConsole
      : (recentConsoles[0]?.id ?? null);
let clientId = localStorage.getItem(STORAGE_CLIENT);
if (!clientId) {
  clientId = crypto.randomUUID().replaceAll("-", "");
  localStorage.setItem(STORAGE_CLIENT, clientId);
}

let status: ConsoleStatus | null = null;
let socket: WebSocket | null = null;
let role: "player" | "spectator" | null = null;
let running = false;
let busy = false;
let shouldReconnect = true;
let advanceOutstanding = false;
let lastFrameAt = 0;
let keyboardButtons = 0;
let pointerButtons = 0;
let gamepadButtons = 0;
let sentButtons = 0;
let reconnectTimer: number | null = null;

const createForm = element<HTMLFormElement>("create-form");
const createRomInput = element<HTMLInputElement>("create-rom-input");
const romInput = element<HTMLInputElement>("rom-input");
const powerButton = element<HTMLButtonElement>("power-button");
const checkpointButton = element<HTMLButtonElement>("checkpoint-button");

createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const file = createRomInput.files?.[0];
  if (file) void createConsole(file);
});
romInput.addEventListener("change", () => {
  const file = romInput.files?.[0];
  if (file) void uploadRom(file);
});
powerButton.addEventListener("click", () => {
  running = !running;
  powerButton.textContent = running ? "PAUSE" : "RUN";
  if (running) {
    requestAdvance();
  } else {
    send({ type: "pause" });
    setMessage("PAUSE REQUESTED / SAVING STATE");
  }
});
checkpointButton.addEventListener("click", () => {
  send({ type: "checkpoint" });
  setMessage("CHECKPOINT IN PROGRESS…");
});
element<HTMLButtonElement>("share-button").addEventListener("click", () => {
  void shareConsole();
});
element<HTMLButtonElement>("fullscreen-button").addEventListener("click", () => {
  void element("console-shell").requestFullscreen();
});
element<HTMLButtonElement>("new-console-button").addEventListener("click", () => {
  commissionNewConsole();
});
element<HTMLButtonElement>("eject-button").addEventListener("click", () => {
  void ejectCartridge();
});
element<HTMLButtonElement>("delete-button").addEventListener("click", () => {
  void deleteConsole();
});

window.setInterval(() => {
  if (role === "player" && socket?.readyState === WebSocket.OPEN) {
    send({ type: "input", buttons: combinedButtons() });
  }
}, 10_000);

const keyButtons: Record<string, Button> = {
  ArrowRight: Button.Right,
  ArrowLeft: Button.Left,
  ArrowUp: Button.Up,
  ArrowDown: Button.Down,
  KeyX: Button.A,
  KeyZ: Button.B,
  Backspace: Button.Select,
  Enter: Button.Start,
};

window.addEventListener("keydown", (event) => {
  const button = keyButtons[event.code];
  if (button === undefined || event.repeat) return;
  event.preventDefault();
  keyboardButtons |= button;
  sendButtons();
});
window.addEventListener("keyup", (event) => {
  const button = keyButtons[event.code];
  if (button === undefined) return;
  event.preventDefault();
  keyboardButtons &= ~button;
  sendButtons();
});
window.addEventListener("blur", () => {
  keyboardButtons = 0;
  pointerButtons = 0;
  sendButtons();
});

const namedButtons: Record<string, Button> = {
  right: Button.Right,
  left: Button.Left,
  up: Button.Up,
  down: Button.Down,
  a: Button.A,
  b: Button.B,
  select: Button.Select,
  start: Button.Start,
};

for (const control of document.querySelectorAll<HTMLButtonElement>("[data-button]")) {
  const button = namedButtons[control.dataset.button ?? ""];
  if (button === undefined) continue;
  const release = (event: PointerEvent) => {
    event.preventDefault();
    control.releasePointerCapture?.(event.pointerId);
    pointerButtons &= ~button;
    control.removeAttribute("data-pressed");
    sendButtons();
  };
  control.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    control.setPointerCapture(event.pointerId);
    pointerButtons |= button;
    control.setAttribute("data-pressed", "");
    sendButtons();
  });
  control.addEventListener("pointerup", release);
  control.addEventListener("pointercancel", release);
}

renderRecentConsoles();
renderStatus(null);
pollGamepads();
if (consoleId) void loadConsole(consoleId);
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}

async function createConsole(file: File): Promise<void> {
  setBusy(true);
  setMessage(`READING ${file.name.toUpperCase()}…`);
  try {
    const metadata = inspectRom(new Uint8Array(await file.arrayBuffer()));
    const response = await fetch("/api/consoles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: metadata.suggestedModel }),
    });
    const created = await responseJson<CreateConsoleResponse>(response);
    status = created.status;
    consoleId = status.id;
    shouldReconnect = true;
    rememberConsole(status, created.ownerToken);
    selectConsole(status.id);
    renderStatus(status);
    connect();
    setMessage(`${metadata.suggestedModel} HARDWARE COMMISSIONED / UPLOADING ROM…`);
    await uploadRom(file);
  } catch (error) {
    setMessage(errorMessage(error), true);
  } finally {
    createRomInput.value = "";
    setBusy(false);
  }
}

async function loadConsole(id: string): Promise<void> {
  if (id !== consoleId) running = false;
  advanceOutstanding = false;
  shouldReconnect = true;
  setMessage("LOCATING PERSISTENT HARDWARE…");
  try {
    const response = await fetch(`/api/consoles/${encodeURIComponent(id)}`);
    status = await responseJson<ConsoleStatus>(response);
    consoleId = status.id;
    rememberConsole(status, ownerToken());
    selectConsole(status.id);
    renderStatus(status);
    connect();
    setMessage(status.cartridge ? "STATE RESTORED FROM EDGE." : "INSERT CARTRIDGE.");
  } catch (error) {
    forgetConsole(id);
    consoleId = null;
    status = null;
    renderStatus(null);
    setMessage(errorMessage(error), true);
  }
}

async function uploadRom(file: File): Promise<void> {
  if (!consoleId) return;
  const capability = ownerToken();
  if (!capability) {
    setMessage("THIS SHARE LINK CANNOT REPLACE THE CARTRIDGE", true);
    return;
  }
  setBusy(true);
  setMessage(`UPLOADING ${file.name.toUpperCase()}…`);
  try {
    const response = await fetch(`/api/consoles/${encodeURIComponent(consoleId)}/cartridge`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${capability}`,
        "Content-Type": "application/octet-stream",
        "X-ROM-Filename": file.name,
      },
      body: file,
    });
    status = await responseJson<ConsoleStatus>(response);
    rememberConsole(status, capability);
    renderStatus(status);
    setMessage("CARTRIDGE LOCKED / FRAME 0 CHECKPOINTED");
  } catch (error) {
    setMessage(errorMessage(error), true);
  } finally {
    romInput.value = "";
    setBusy(false);
  }
}

async function ejectCartridge(): Promise<void> {
  const capability = ownerToken();
  if (!consoleId || !capability || !confirm("Eject this cartridge and discard its checkpoints?"))
    return;
  setBusy(true);
  setMessage("FLUSHING BATTERY / EJECTING CARTRIDGE…");
  try {
    const response = await fetch(`/api/consoles/${encodeURIComponent(consoleId)}/cartridge`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${capability}` },
    });
    status = await responseJson<ConsoleStatus>(response);
    rememberConsole(status, capability);
    running = false;
    renderStatus(status);
    setMessage("CARTRIDGE EJECTED");
  } catch (error) {
    setMessage(errorMessage(error), true);
  } finally {
    setBusy(false);
  }
}

async function deleteConsole(): Promise<void> {
  const capability = ownerToken();
  const id = consoleId;
  if (!id || !capability || !confirm(`Permanently delete ${id} and all stored data?`)) return;
  setBusy(true);
  setMessage("DELETING DURABLE OBJECT DATA…");
  try {
    const response = await fetch(`/api/consoles/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${capability}` },
    });
    if (!response.ok) await responseJson(response);
    shouldReconnect = false;
    socket?.close();
    forgetConsole(id);
    consoleId = null;
    status = null;
    role = null;
    running = false;
    selectConsole(null);
    renderStatus(null);
    setNetwork("OFFLINE");
    setMessage("CONSOLE AND OBJECT DATA DELETED");
  } catch (error) {
    setMessage(errorMessage(error), true);
  } finally {
    setBusy(false);
  }
}

async function shareConsole(): Promise<void> {
  if (!consoleId) return;
  const shareUrl = new URL(location.origin);
  shareUrl.searchParams.set("console", consoleId);
  try {
    await navigator.clipboard.writeText(shareUrl.toString());
    setMessage("SPECTATOR-CAPABLE LINK COPIED / OWNER KEY EXCLUDED");
  } catch {
    prompt("Copy this share link", shareUrl.toString());
  }
}

function commissionNewConsole(): void {
  shouldReconnect = false;
  socket?.close();
  socket = null;
  consoleId = null;
  status = null;
  role = null;
  running = false;
  advanceOutstanding = false;
  selectConsole(null);
  renderStatus(null);
  setNetwork("OFFLINE");
  setMessage("SELECT A ROM TO COMMISSION NEW HARDWARE");
}

function connect(): void {
  if (!consoleId || !clientId) return;
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  advanceOutstanding = false;
  const previous = socket;
  socket = null;
  previous?.close();
  setNetwork("CONNECTING");
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const connection = new WebSocket(
    `${protocol}//${location.host}/api/consoles/${encodeURIComponent(consoleId)}/ws?clientId=${encodeURIComponent(clientId)}`,
  );
  socket = connection;
  connection.binaryType = "arraybuffer";
  connection.addEventListener("open", () => {
    if (socket === connection) setNetwork("ONLINE");
  });
  connection.addEventListener("message", (event) => {
    if (socket === connection) handleMessage(event);
  });
  connection.addEventListener("close", () => {
    if (socket !== connection) return;
    role = null;
    advanceOutstanding = false;
    syncControls();
    if (!shouldReconnect || !consoleId) {
      setNetwork("OFFLINE");
      return;
    }
    setNetwork("RECONNECTING");
    reconnectTimer = window.setTimeout(connect, 1_500);
  });
  connection.addEventListener("error", () => {
    if (socket === connection) setNetwork("FAULT");
  });
}

function handleMessage(event: MessageEvent<string | ArrayBuffer>): void {
  if (event.data instanceof ArrayBuffer) {
    try {
      const frame = decodeFrame(event.data);
      const pixels = unpackFrameRgba(frame);
      const imagePixels = new Uint8ClampedArray(pixels.byteLength);
      imagePixels.set(pixels);
      context.putImageData(new ImageData(imagePixels, frame.width, frame.height), 0, 0);
      element("screen-empty").hidden = true;
      element("frame-count").textContent = frame.frame.toLocaleString();
      lastFrameAt = performance.now();
      advanceOutstanding = false;
      requestAdvance();
    } catch (error) {
      setMessage(errorMessage(error), true);
    }
    return;
  }

  const message: ServerMessage = JSON.parse(event.data);
  switch (message.type) {
    case "hello":
    case "role":
      role = message.role;
      status = message.status;
      renderStatus(status);
      if (role === "spectator") {
        running = false;
        setMessage("SPECTATING / WAITING FOR CONTROLLER LEASE");
      } else {
        setMessage(message.type === "role" ? "CONTROLLER LEASE ACQUIRED" : "CONTROL CHANNEL READY");
        sendButtons(true);
        requestAdvance();
      }
      break;
    case "status":
      status = message.status;
      renderStatus(status);
      break;
    case "checkpointed":
      status = message.status;
      renderStatus(status);
      setMessage(`CHECKPOINT COMMITTED / FRAME ${message.status.frame}`);
      break;
    case "error":
      advanceOutstanding = false;
      setMessage(`${message.code.toUpperCase()} / ${message.message}`, true);
      break;
  }
}

function requestAdvance(): void {
  if (
    !running ||
    role !== "player" ||
    advanceOutstanding ||
    socket?.readyState !== WebSocket.OPEN ||
    !status?.cartridge
  )
    return;
  const delay = Math.max(0, FRAME_INTERVAL_MS - (performance.now() - lastFrameAt));
  window.setTimeout(() => {
    if (!running || advanceOutstanding) return;
    advanceOutstanding = true;
    send({ type: "advance", frames: ADVANCE_FRAMES });
  }, delay);
}

function combinedButtons(): number {
  return keyboardButtons | pointerButtons | gamepadButtons;
}

function sendButtons(force = false): void {
  const next = combinedButtons();
  if (!force && next === sentButtons) return;
  sentButtons = next;
  send({ type: "input", buttons: next });
}

function pollGamepads(): void {
  const gamepad = navigator.getGamepads?.().find((candidate) => candidate?.connected);
  let next = 0;
  if (gamepad) {
    if (gamepad.buttons[15]?.pressed || (gamepad.axes[0] ?? 0) > 0.5) next |= Button.Right;
    if (gamepad.buttons[14]?.pressed || (gamepad.axes[0] ?? 0) < -0.5) next |= Button.Left;
    if (gamepad.buttons[12]?.pressed || (gamepad.axes[1] ?? 0) < -0.5) next |= Button.Up;
    if (gamepad.buttons[13]?.pressed || (gamepad.axes[1] ?? 0) > 0.5) next |= Button.Down;
    if (gamepad.buttons[0]?.pressed) next |= Button.A;
    if (gamepad.buttons[1]?.pressed) next |= Button.B;
    if (gamepad.buttons[8]?.pressed) next |= Button.Select;
    if (gamepad.buttons[9]?.pressed) next |= Button.Start;
  }
  if (next !== gamepadButtons) {
    gamepadButtons = next;
    sendButtons();
  }
  requestAnimationFrame(pollGamepads);
}

function send(message: object): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function renderStatus(next: ConsoleStatus | null): void {
  const hasConsole = next !== null;
  const hasCartridge = next?.cartridge !== null && next?.cartridge !== undefined;
  if (!hasCartridge) running = false;
  const ownsConsole = Boolean(ownerToken());
  element("setup-panel").toggleAttribute("hidden", hasConsole);
  element("cartridge-panel").toggleAttribute("hidden", !hasConsole || hasCartridge || !ownsConsole);
  element("run-panel").toggleAttribute("hidden", !hasCartridge);
  element("console-actions").toggleAttribute("hidden", !hasConsole);
  element("owner-actions").toggleAttribute("hidden", !hasConsole || !ownsConsole);
  element("screen-empty").toggleAttribute("hidden", hasCartridge);
  element("console-id").textContent = next?.id ?? "—";
  element("model-stamp").textContent = next ? `${next.model} MODEL` : "AUTO MODEL";
  element("lifecycle").textContent = next?.lifecycle.toUpperCase() ?? "EMPTY";
  element("frame-count").textContent = BigInt(next?.frame ?? "0").toLocaleString();
  element("virtual-time").textContent = `${(next?.telemetry.emulatedSeconds ?? 0).toFixed(2)} s`;
  element("memory-use").textContent =
    `${((next?.telemetry.wasmMemoryBytes ?? 0) / 1_048_576).toFixed(1)} MiB`;
  element("state-size").textContent =
    `${Math.round((next?.telemetry.lastStateBytes ?? 0) / 1024)} KiB`;
  element("cartridge-title").textContent = next?.cartridge?.title ?? "UNTITLED";
  element("cartridge-hash").textContent = next?.cartridge
    ? `SHA256 / ${next.cartridge.hash.slice(0, 16).toUpperCase()}`
    : "SHA256 / —";
  element("role-label").textContent = role?.toUpperCase() ?? "UNASSIGNED";
  powerButton.textContent = running ? "PAUSE" : "RUN";
  syncControls();
}

function syncControls(): void {
  const playerDisabled = busy || role !== "player";
  powerButton.disabled = playerDisabled;
  checkpointButton.disabled = playerDisabled;
  createRomInput.disabled = busy;
  romInput.disabled = busy || !ownerToken();
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-owner-action]")) {
    button.disabled = busy || !ownerToken();
  }
}

function setNetwork(label: string): void {
  element("network-label").textContent = label;
  element("network-lamp").dataset.state = label.toLowerCase();
}

function setBusy(next: boolean): void {
  busy = next;
  syncControls();
}

function setMessage(message: string, error = false): void {
  const output = element("operation-message");
  output.textContent = message;
  output.toggleAttribute("data-error", error);
}

function ownerToken(): string | undefined {
  return recentConsoles.find((entry) => entry.id === consoleId)?.ownerToken;
}

function rememberConsole(next: ConsoleStatus, capability?: string): void {
  const existing = recentConsoles.find((entry) => entry.id === next.id);
  const entry: RecentConsole = {
    id: next.id,
    model: next.model,
    title: next.cartridge?.title ?? null,
    ownerToken: capability ?? existing?.ownerToken,
    lastOpened: Date.now(),
  };
  recentConsoles = [entry, ...recentConsoles.filter((candidate) => candidate.id !== next.id)].slice(
    0,
    12,
  );
  saveRecentConsoles();
  renderRecentConsoles();
}

function forgetConsole(id: string): void {
  recentConsoles = recentConsoles.filter((entry) => entry.id !== id);
  saveRecentConsoles();
  renderRecentConsoles();
}

function renderRecentConsoles(): void {
  const list = element<HTMLUListElement>("recent-consoles");
  list.replaceChildren();
  for (const entry of recentConsoles) {
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<strong>${escapeHtml(entry.title ?? "EMPTY CONSOLE")}</strong><span>${entry.model} / ${escapeHtml(entry.id.slice(-8))}${entry.ownerToken ? " / OWNER" : ""}</span>`;
    button.addEventListener("click", () => void loadConsole(entry.id));
    const item = document.createElement("li");
    item.append(button);
    list.append(item);
  }
  element("recent-panel").toggleAttribute("hidden", recentConsoles.length === 0);
}

function selectConsole(id: string | null): void {
  const url = new URL(location.href);
  if (id) url.searchParams.set("console", id);
  else url.searchParams.delete("console");
  history.replaceState(null, "", url);
  localStorage.removeItem(LEGACY_STORAGE_CONSOLE);
}

function loadRecentConsoles(): RecentConsole[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_CONSOLES) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (entry): entry is RecentConsole =>
          typeof entry === "object" &&
          entry !== null &&
          "id" in entry &&
          typeof entry.id === "string" &&
          isConsoleId(entry.id) &&
          "model" in entry &&
          (entry.model === "DMG" || entry.model === "CGB"),
      )
      .sort((left, right) => right.lastOpened - left.lastOpened);
  } catch {
    return [];
  }
}

function saveRecentConsoles(): void {
  localStorage.setItem(STORAGE_CONSOLES, JSON.stringify(recentConsoles));
}

async function responseJson<T>(response: Response): Promise<T> {
  const value = (await response.json()) as T & {
    error?: string | { code: string; message: string };
    requestId?: string;
  };
  if (!response.ok) {
    const message =
      typeof value.error === "string"
        ? value.error
        : (value.error?.message ?? `Request failed (${response.status})`);
    throw new Error(value.requestId ? `${message} [${value.requestId}]` : message);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.toUpperCase() : "OPERATION FAILED";
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[character] ?? character,
  );
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

function requireCanvasContext(canvasElement: HTMLCanvasElement): CanvasRenderingContext2D {
  const renderingContext = canvasElement.getContext("2d", { alpha: false });
  if (!renderingContext) throw new Error("Canvas 2D is unavailable");
  return renderingContext;
}
