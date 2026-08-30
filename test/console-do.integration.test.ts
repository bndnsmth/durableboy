import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import type { ConsoleDO } from "../src/console-do";
import type { ConsoleStatus, ServerMessage } from "../src/shared/protocol";

interface CreatedConsole {
  status: ConsoleStatus;
  ownerToken: string;
}

interface ConnectedSocket {
  socket: WebSocket;
  hello: ServerMessage;
}

describe("ConsoleDO integration", () => {
  it("enforces ownership and removes all console storage", async () => {
    const created = await createConsole();
    const invalidToken = "x".repeat(43);

    const rejectedUpload = await uploadRom(created.status.id, invalidToken);
    expect(rejectedUpload.status).toBe(403);
    expect(await env.DURABLEBOY_DATA.list({ prefix: prefix(created.status.id) })).toMatchObject({
      objects: [],
    });

    const uploaded = await uploadRom(created.status.id, created.ownerToken);
    expect(uploaded.status).toBe(201);
    const uploadedStatus = await uploaded.json<ConsoleStatus>();
    expect(uploadedStatus.cartridge?.title).toBe("DB-INTEGRATION");

    const stored = await env.DURABLEBOY_DATA.list({ prefix: prefix(created.status.id) });
    expect(stored.objects.some((object) => object.key.includes("/roms/"))).toBe(true);
    expect(stored.objects.some((object) => object.key.includes("/states/"))).toBe(true);

    const rejectedDelete = await deleteConsole(created.status.id, invalidToken);
    expect(rejectedDelete.status).toBe(403);

    const deleted = await deleteConsole(created.status.id, created.ownerToken);
    expect(deleted.status).toBe(204);
    expect(await env.DURABLEBOY_DATA.list({ prefix: prefix(created.status.id) })).toMatchObject({
      objects: [],
    });
    expect((await api(`/api/consoles/${created.status.id}`)).status).toBe(404);
  });

  it("compacts input transitions after a checkpoint", async () => {
    const created = await createConsole();
    expect((await uploadRom(created.status.id, created.ownerToken)).status).toBe(201);

    const connection = await connect(created.status.id, "compaction-client");
    expect(connection.hello.type).toBe("hello");

    const checkpointed = nextJson(connection.socket, (message) => message.type === "checkpointed");
    connection.socket.send(JSON.stringify({ type: "input", buttons: 16 }));
    connection.socket.send(JSON.stringify({ type: "checkpoint" }));
    expect((await checkpointed).type).toBe("checkpointed");

    const stub = env.CONSOLES.getByName(created.status.id);
    await runInDurableObject(stub, async (_instance: ConsoleDO, state) => {
      const inputCount = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM inputs")
        .one().count;
      const machine = state.storage.sql
        .exec<{ input_seq: number }>("SELECT input_seq FROM machine WHERE singleton = 1")
        .one();
      expect(machine.input_seq).toBe(1);
      expect(inputCount).toBe(0);
    });

    await deleteConsole(created.status.id, created.ownerToken);
  });

  it("promotes the next controller candidate", async () => {
    const created = await createConsole();
    const player = await connect(created.status.id, "primary-player");
    const spectator = await connect(created.status.id, "waiting-player");

    expect(player.hello.type === "hello" && player.hello.role).toBe("player");
    expect(spectator.hello.type === "hello" && spectator.hello.role).toBe("spectator");

    const promoted = nextJson(spectator.socket, (message) => message.type === "role");
    player.socket.close(1000, "test handoff");
    const roleMessage = await promoted;
    expect(roleMessage.type === "role" && roleMessage.role).toBe("player");

    await deleteConsole(created.status.id, created.ownerToken);
  });
});

async function createConsole(): Promise<CreatedConsole> {
  const response = await api("/api/consoles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "DMG" }),
  });
  expect(response.status).toBe(201);
  return await response.json<CreatedConsole>();
}

async function uploadRom(consoleId: string, ownerToken: string): Promise<Response> {
  return await api(`/api/consoles/${consoleId}/cartridge`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": "application/octet-stream",
    },
    body: integrationRom().buffer as ArrayBuffer,
  });
}

async function deleteConsole(consoleId: string, ownerToken: string): Promise<Response> {
  return await api(`/api/consoles/${consoleId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
}

async function connect(consoleId: string, clientId: string): Promise<ConnectedSocket> {
  const response = await api(`/api/consoles/${consoleId}/ws?clientId=${clientId}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  expect(response.webSocket).not.toBeNull();
  const socket = response.webSocket as WebSocket;
  const hello = nextJson(socket, (message) => message.type === "hello");
  socket.accept();
  return { socket, hello: await hello };
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return await exports.default.fetch(new Request(`https://durableboy.test${path}`, init));
}

function nextJson(
  socket: WebSocket,
  predicate: (message: ServerMessage) => boolean,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, 5_000);
    const onMessage = (event: MessageEvent): void => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as ServerMessage;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
  });
}

function integrationRom(): Uint8Array {
  const rom = new Uint8Array(32 * 1024);
  rom.set(new TextEncoder().encode("DB-INTEGRATION"), 0x134);
  rom[0x100] = 0x18;
  rom[0x101] = 0xfe;
  return rom;
}

function prefix(consoleId: string): string {
  return `consoles/${consoleId}/`;
}
