import { DurableObject } from "cloudflare:workers";
import {
  migrateConsoleSchema,
  type CheckpointRow,
  type InputRow,
  type MachineRow,
  type TelemetryRow,
} from "./console/schema";
import { SameBoyEmulator } from "./emulator/sameboy";
import type { Emulator } from "./emulator/types";
import {
  encodeFrame,
  parseClientMessage,
  type ConsoleLifecycle,
  type ConsoleModel,
  type ConsoleStatus,
  type ServerMessage,
} from "./shared/protocol";
import { MAX_ROM_BYTES, sha256Hex } from "./shared/rom";

const CHECKPOINT_INTERVAL_FRAMES = 300n;
const CONTROLLER_LEASE_MS = 30_000;

interface SocketAttachment {
  clientId: string;
  role: "player" | "spectator";
  wantsControl: boolean;
  connectedAt: number;
}

export interface CartridgeReference {
  id: string;
  romHash: string;
  romKey: string;
  title: string;
}

export interface ReplayVerification {
  frame: string;
  expectedHash: string;
  replayHash: string;
  deterministic: boolean;
}

export class ConsoleDO extends DurableObject<Env> {
  #emulator: Emulator | null = null;
  #loading: Promise<Emulator> | null = null;
  #mutationTail: Promise<void> = Promise.resolve();
  #deleting = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    void this.ctx.blockConcurrencyWhile(async () => {
      migrateConsoleSchema(this.ctx.storage.sql);
    });
  }

  async initialize(
    consoleId: string,
    model: ConsoleModel,
    ownerHash: string,
  ): Promise<ConsoleStatus> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO machine (
        singleton, console_id, model, lifecycle, owner_hash, frame, ticks, buttons,
        input_seq, created_at, updated_at
      ) VALUES (1, ?, ?, 'empty', ?, '0', '0', 0, 0, ?, ?)`,
      consoleId,
      model,
      ownerHash,
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO telemetry (
        singleton, frames_run, chunks_run, observed_wall_ms,
        wasm_memory_bytes, last_state_bytes
      ) VALUES (1, '0', 0, 0, 0, 0)`,
    );

    const row = this.requireMachine();
    if (row.console_id !== consoleId || row.model !== model) {
      throw new Error("Console identity does not match its Durable Object");
    }
    return this.statusFrom(row);
  }

  async getStatus(): Promise<ConsoleStatus> {
    return this.statusFrom(this.requireMachine());
  }

  async insertCartridge(
    cartridge: CartridgeReference,
    rom: Uint8Array,
    ownerToken: string,
  ): Promise<ConsoleStatus> {
    return await this.serialized(async () => {
      const row = this.requireMachine();
      await this.assertOwner(row, ownerToken);
      if (rom.byteLength > MAX_ROM_BYTES) {
        throw namedError("PayloadTooLargeError", "Cartridge ROM is too large");
      }
      await this.env.DURABLEBOY_DATA.put(cartridge.romKey, rom, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: {
          sha256: cartridge.romHash,
          title: cartridge.title,
          model: row.model,
        },
      });
      try {
        return await this.insertCartridgeInternal(cartridge);
      } catch (error) {
        if (this.machine()?.rom_key !== cartridge.romKey) {
          await this.deleteObjects([cartridge.romKey]);
        }
        throw error;
      }
    });
  }

  private async insertCartridgeInternal(cartridge: CartridgeReference): Promise<ConsoleStatus> {
    const current = this.requireMachine();
    if (current.lifecycle === "loading" || current.lifecycle === "checkpointing") {
      throw new Error("Console is busy");
    }

    this.ctx.storage.sql.exec(
      "UPDATE machine SET lifecycle = 'loading', updated_at = ? WHERE singleton = 1",
      Date.now(),
    );

    try {
      if (this.#emulator && current.cartridge_hash) {
        await this.flushBattery(current, this.#emulator);
      }
      const oldCheckpointKeys = this.ctx.storage.sql
        .exec<{ object_key: string }>("SELECT object_key FROM checkpoints")
        .toArray()
        .map((row) => row.object_key);
      const object = await this.env.DURABLEBOY_DATA.get(cartridge.romKey);
      if (!object || object.size > MAX_ROM_BYTES) {
        throw new Error("Cartridge ROM is missing or too large");
      }
      const rom = new Uint8Array(await object.arrayBuffer());

      this.#emulator?.destroy();
      this.#emulator = await SameBoyEmulator.create(current.model, rom);
      this.#loading = null;

      const incomingBatteryKey = consoleObjectKey(
        current.console_id,
        `saves/${cartridge.romHash}.sav`,
      );
      const incomingBattery = await this.env.DURABLEBOY_DATA.get(incomingBatteryKey);
      if (incomingBattery) {
        this.#emulator.loadBattery(new Uint8Array(await incomingBattery.arrayBuffer()));
        this.#emulator.clearBatteryDirty();
      }

      this.ctx.storage.sql.exec("DELETE FROM inputs");
      this.ctx.storage.sql.exec("DELETE FROM checkpoints");
      this.ctx.storage.sql.exec(
        `UPDATE machine SET
          lifecycle = 'paused', cartridge_id = ?, cartridge_hash = ?,
          cartridge_title = ?, rom_key = ?, battery_key = ?,
          frame = '0', ticks = '0', buttons = 0, input_seq = 0,
          checkpoint_key = NULL, checkpoint_hash = NULL, updated_at = ?
        WHERE singleton = 1`,
        cartridge.id,
        cartridge.romHash,
        cartridge.title,
        cartridge.romKey,
        incomingBattery ? incomingBatteryKey : null,
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        `UPDATE telemetry SET frames_run = '0', chunks_run = 0,
          observed_wall_ms = 0, wasm_memory_bytes = ?, last_state_bytes = 0
        WHERE singleton = 1`,
        this.#emulator.memoryBytes,
      );

      const status = await this.createCheckpoint("paused");
      if (current.rom_key && current.rom_key !== cartridge.romKey) {
        oldCheckpointKeys.push(current.rom_key);
      }
      await this.deleteObjects(oldCheckpointKeys);
      return status;
    } catch (error) {
      this.ctx.storage.sql.exec(
        "UPDATE machine SET lifecycle = 'faulted', updated_at = ? WHERE singleton = 1",
        Date.now(),
      );
      throw error;
    }
  }

  async ejectCartridge(ownerToken: string): Promise<ConsoleStatus> {
    return await this.serialized(async () => {
      const row = this.requireMachine();
      await this.assertOwner(row, ownerToken);
      if (!row.cartridge_id) {
        return this.statusFrom(row);
      }
      if (row.lifecycle === "loading" || row.lifecycle === "checkpointing") {
        throw namedError("ConflictError", "Console is busy");
      }
      if (this.#emulator) {
        await this.flushBattery(row, this.#emulator);
        this.#emulator.destroy();
        this.#emulator = null;
        this.#loading = null;
      }
      const objectKeys = this.ctx.storage.sql
        .exec<{ object_key: string }>("SELECT object_key FROM checkpoints")
        .toArray()
        .map((checkpoint) => checkpoint.object_key);
      if (row.rom_key) objectKeys.push(row.rom_key);
      this.ctx.storage.sql.exec("DELETE FROM inputs");
      this.ctx.storage.sql.exec("DELETE FROM checkpoints");
      this.ctx.storage.sql.exec(
        `UPDATE machine SET lifecycle = 'empty', cartridge_id = NULL,
          cartridge_hash = NULL, cartridge_title = NULL, rom_key = NULL,
          battery_key = NULL, frame = '0', ticks = '0', buttons = 0,
          input_seq = 0, checkpoint_key = NULL, checkpoint_hash = NULL,
          updated_at = ? WHERE singleton = 1`,
        Date.now(),
      );
      await this.deleteObjects(objectKeys);
      const status = this.statusFrom(this.requireMachine());
      this.broadcastStatus();
      return status;
    });
  }

  async pause(): Promise<ConsoleStatus> {
    return await this.serialized(async () => await this.pauseInternal());
  }

  private async pauseInternal(): Promise<ConsoleStatus> {
    const row = this.requireMachine();
    if (!row.cartridge_id) {
      return this.statusFrom(row);
    }
    this.ctx.storage.sql.exec(
      "UPDATE machine SET lifecycle = 'paused', updated_at = ? WHERE singleton = 1",
      Date.now(),
    );
    return await this.createCheckpoint("paused");
  }

  async checkpoint(): Promise<ConsoleStatus> {
    return await this.serialized(async () => await this.checkpointInternal());
  }

  private async checkpointInternal(): Promise<ConsoleStatus> {
    const row = this.requireMachine();
    if (!row.cartridge_id) {
      return this.statusFrom(row);
    }
    const nextLifecycle =
      this.activePlayerCount() > 0
        ? row.lifecycle === "running"
          ? "running"
          : "paused"
        : "sleeping";
    return await this.createCheckpoint(nextLifecycle);
  }

  async verifyReplay(): Promise<ReplayVerification> {
    return await this.serialized(async () => {
      const row = this.requireMachine();
      const active = await this.ensureEmulator(row);
      const expectedHash = active.stateHash();
      const replay = await this.restoreEmulator(row);
      const replayHash = replay.stateHash();
      replay.destroy();
      return {
        frame: row.frame,
        expectedHash,
        replayHash,
        deterministic: expectedHash === replayHash,
      };
    });
  }

  async deleteConsole(ownerToken: string): Promise<void> {
    await this.serialized(async () => {
      const row = this.requireMachine();
      await this.assertOwner(row, ownerToken);
      this.#deleting = true;
      this.ctx.storage.sql.exec(
        "UPDATE machine SET lifecycle = 'deleting', updated_at = ? WHERE singleton = 1",
        Date.now(),
      );
      for (const socket of this.ctx.getWebSockets()) {
        socket.close(1001, "Console deleted");
      }
      this.#emulator?.destroy();
      this.#emulator = null;
      this.#loading = null;

      const legacyKeys = this.ctx.storage.sql
        .exec<{ object_key: string }>("SELECT object_key FROM checkpoints")
        .toArray()
        .map((checkpoint) => checkpoint.object_key);
      if (row.rom_key) legacyKeys.push(row.rom_key);
      if (row.battery_key) legacyKeys.push(row.battery_key);
      await this.deleteObjects(legacyKeys);
      await this.deleteConsolePrefix(row.console_id);
      await this.ctx.storage.deleteAll();
      migrateConsoleSchema(this.ctx.storage.sql);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const row = this.machine();
    if (!row) {
      return new Response("Console does not exist", { status: 404 });
    }

    const url = new URL(request.url);
    const clientId = sanitizeClientId(url.searchParams.get("clientId"));
    const spectatorOnly = url.searchParams.get("role") === "spectator";
    const wantsControl = !spectatorOnly;
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE expires_at <= ?", now);
    const activePlayer = this.activePlayerCount() > 0;
    const lease = this.ctx.storage.sql
      .exec<{ owner: string }>(
        "SELECT owner FROM leases WHERE resource = 'controller' AND expires_at > ?",
        now,
      )
      .toArray()[0];
    const role =
      !spectatorOnly && !activePlayer && (!lease || lease.owner === clientId)
        ? "player"
        : "spectator";

    if (role === "player") {
      this.ctx.storage.sql.exec(
        `INSERT INTO leases (resource, owner, expires_at)
        VALUES ('controller', ?, ?)
        ON CONFLICT(resource) DO UPDATE SET owner = excluded.owner,
          expires_at = excluded.expires_at`,
        clientId,
        now + CONTROLLER_LEASE_MS,
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      clientId,
      role,
      wantsControl,
      connectedAt: now,
    } satisfies SocketAttachment);

    if (row.lifecycle === "sleeping") {
      this.ctx.storage.sql.exec(
        "UPDATE machine SET lifecycle = 'paused', updated_at = ? WHERE singleton = 1",
        now,
      );
    }

    this.sendJson(server, {
      type: "hello",
      role,
      status: this.statusFrom(this.requireMachine()),
    });
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        "X-Request-ID": request.headers.get("X-Request-ID") ?? crypto.randomUUID(),
      },
    });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socketAttachment(socket);
    if (!attachment) {
      this.sendError(socket, "invalid_session", "Connection metadata is missing");
      return;
    }
    if (typeof message !== "string") {
      this.sendError(socket, "invalid_message", "Client messages must be JSON");
      return;
    }

    try {
      const parsed = parseClientMessage(message);
      if (attachment.role !== "player") {
        throw new Error("This connection is read-only");
      }
      this.assertLease(attachment.clientId, socket);
      await this.serialized(async () => {
        this.refreshLease(attachment.clientId);

        switch (parsed.type) {
          case "input":
            await this.recordInput(parsed.buttons);
            break;
          case "advance":
            await this.advance(parsed.frames ?? 1);
            break;
          case "checkpoint":
            this.sendJson(socket, {
              type: "checkpointed",
              status: await this.checkpointInternal(),
            });
            this.broadcastStatus();
            break;
          case "pause":
            await this.pauseInternal();
            this.broadcastStatus();
            break;
        }
      });
    } catch (error) {
      this.sendError(
        socket,
        "command_failed",
        error instanceof Error ? error.message : "Command failed",
      );
    }
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    if (this.#deleting) {
      return;
    }
    const attachment = socketAttachment(socket);
    await this.serialized(async () => {
      if (attachment?.role === "player") {
        const row = this.machine();
        if (row?.cartridge_id && row.lifecycle !== "faulted") {
          await this.recordInput(0);
        }
        this.ctx.storage.sql.exec(
          "DELETE FROM leases WHERE resource = 'controller' AND owner = ?",
          attachment.clientId,
        );
      }

      this.promoteNextSpectator();

      if (this.activePlayerCount() === 0) {
        const row = this.machine();
        if (row?.cartridge_id && row.lifecycle !== "faulted") {
          this.ctx.storage.sql.exec(
            "UPDATE machine SET lifecycle = 'sleeping', updated_at = ? WHERE singleton = 1",
            Date.now(),
          );
          await this.createCheckpoint("sleeping");
        }
      }
      if (this.machine()) {
        this.broadcastStatus();
      }
    });

    console.log(
      JSON.stringify({
        message: "console websocket closed",
        consoleId: this.machine()?.console_id,
        code,
        reason,
      }),
    );
  }

  override webSocketError(socket: WebSocket, error: unknown): void {
    const attachment = socketAttachment(socket);
    console.error(
      JSON.stringify({
        message: "console websocket error",
        consoleId: this.machine()?.console_id,
        clientId: attachment?.clientId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  private machine(): MachineRow | null {
    return (
      this.ctx.storage.sql
        .exec<MachineRow>("SELECT * FROM machine WHERE singleton = 1")
        .toArray()[0] ?? null
    );
  }

  private requireMachine(): MachineRow {
    const row = this.machine();
    if (!row) {
      throw namedError("NotFoundError", "Console does not exist");
    }
    return row;
  }

  private statusFrom(row: MachineRow): ConsoleStatus {
    const telemetry = this.ctx.storage.sql
      .exec<TelemetryRow>("SELECT * FROM telemetry WHERE singleton = 1")
      .toArray()[0] ?? {
      frames_run: "0",
      chunks_run: 0,
      observed_wall_ms: 0,
      wasm_memory_bytes: 0,
      last_state_bytes: 0,
    };
    const emulatedSeconds = Number(BigInt(row.ticks)) / 8_388_608;
    return {
      id: row.console_id,
      model: row.model,
      lifecycle: row.lifecycle,
      cartridge:
        row.cartridge_id && row.cartridge_hash
          ? {
              id: row.cartridge_id,
              hash: row.cartridge_hash,
              title: row.cartridge_title ?? "UNTITLED CARTRIDGE",
            }
          : null,
      frame: row.frame,
      ticks: row.ticks,
      checkpointHash: row.checkpoint_hash,
      connectedClients: this.ctx.getWebSockets().length,
      hasController: this.activePlayerCount() > 0,
      telemetry: {
        framesRun: telemetry.frames_run,
        chunksRun: telemetry.chunks_run,
        emulatedSeconds,
        observedWallMs: telemetry.observed_wall_ms,
        wasmMemoryBytes: telemetry.wasm_memory_bytes,
        lastStateBytes: telemetry.last_state_bytes,
      },
    };
  }

  private async recordInput(buttons: number): Promise<void> {
    const row = this.requireMachine();
    if (!row.cartridge_id || row.lifecycle === "faulted") {
      throw new Error("No runnable cartridge is inserted");
    }
    if (row.buttons === buttons) {
      return;
    }

    const input = this.ctx.storage.sql
      .exec<{ seq: number }>(
        `INSERT INTO inputs (frame, ticks, player, buttons, created_at)
        VALUES (?, ?, 0, ?, ?) RETURNING seq`,
        row.frame,
        row.ticks,
        buttons,
        Date.now(),
      )
      .one();
    this.ctx.storage.sql.exec(
      "UPDATE machine SET buttons = ?, input_seq = ?, updated_at = ? WHERE singleton = 1",
      buttons,
      input.seq,
      Date.now(),
    );
    this.#emulator?.setButtons(buttons);
  }

  private async advance(frames: number): Promise<void> {
    let row = this.requireMachine();
    if (!row.cartridge_id || row.lifecycle === "faulted") {
      throw new Error("No runnable cartridge is inserted");
    }

    const emulator = await this.ensureEmulator(row);
    const started = performance.now();
    let frame = BigInt(row.frame);
    let ticks = BigInt(row.ticks);
    for (let index = 0; index < frames; index += 1) {
      ticks += emulator.runFrame();
      frame += 1n;
    }
    const observedWallMs = Math.max(0, performance.now() - started);

    this.ctx.storage.sql.exec(
      `UPDATE machine SET lifecycle = 'running', frame = ?, ticks = ?,
        updated_at = ? WHERE singleton = 1`,
      frame.toString(),
      ticks.toString(),
      Date.now(),
    );
    this.ctx.storage.sql.exec(
      `UPDATE telemetry SET
        frames_run = CAST(CAST(frames_run AS INTEGER) + ? AS TEXT),
        chunks_run = chunks_run + 1,
        observed_wall_ms = observed_wall_ms + ?,
        wasm_memory_bytes = ?
      WHERE singleton = 1`,
      frames,
      observedWallMs,
      emulator.memoryBytes,
    );

    row = this.requireMachine();
    const checkpoint = this.latestCheckpoint();
    if (!checkpoint || frame - BigInt(checkpoint.frame) >= CHECKPOINT_INTERVAL_FRAMES) {
      await this.createCheckpoint("running");
      row = this.requireMachine();
    }

    const encoded = encodeFrame(emulator.framebuffer(), row.model, frame, ticks);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(encoded.slice(0));
      } catch {
        // The close event owns lease cleanup and checkpointing.
      }
    }
    if (frame % 60n < BigInt(frames)) {
      this.broadcastStatus();
    }

    console.log(
      JSON.stringify({
        message: "emulator chunk",
        consoleId: row.console_id,
        frames,
        frame: frame.toString(),
        ticks: ticks.toString(),
        observedWallMs,
        wasmMemoryBytes: emulator.memoryBytes,
      }),
    );
  }

  private latestCheckpoint(): CheckpointRow | null {
    return (
      this.ctx.storage.sql
        .exec<CheckpointRow>("SELECT * FROM checkpoints ORDER BY id DESC LIMIT 1")
        .toArray()[0] ?? null
    );
  }

  private async createCheckpoint(nextLifecycle: ConsoleLifecycle): Promise<ConsoleStatus> {
    const before = this.requireMachine();
    const emulator = await this.ensureEmulator(before);
    this.ctx.storage.sql.exec(
      "UPDATE machine SET lifecycle = 'checkpointing', updated_at = ? WHERE singleton = 1",
      Date.now(),
    );

    try {
      const state = emulator.saveState();
      const [sha256, stateHash] = await Promise.all([
        sha256Hex(state),
        Promise.resolve(emulator.stateHash()),
      ]);
      const stateKey = consoleObjectKey(
        before.console_id,
        `states/${before.frame}-${sha256.slice(0, 16)}.state`,
      );
      await this.env.DURABLEBOY_DATA.put(stateKey, state, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: {
          consoleId: before.console_id,
          frame: before.frame,
          sameBoyStateHash: stateHash,
        },
      });

      const batteryWasDirty = emulator.batteryDirty();
      const batteryKey = await this.flushBattery(before, emulator);

      this.ctx.storage.sql.exec(
        `INSERT INTO checkpoints (
          frame, ticks, buttons, input_seq, object_key, sha256, state_hash,
          byte_size, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        before.frame,
        before.ticks,
        before.buttons,
        before.input_seq,
        stateKey,
        sha256,
        stateHash,
        state.byteLength,
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        `UPDATE machine SET lifecycle = ?, checkpoint_key = ?,
          checkpoint_hash = ?, battery_key = ?, updated_at = ?
        WHERE singleton = 1`,
        nextLifecycle,
        stateKey,
        sha256,
        batteryKey,
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        `UPDATE telemetry SET last_state_bytes = ?, wasm_memory_bytes = ?
        WHERE singleton = 1`,
        state.byteLength,
        emulator.memoryBytes,
      );
      if (batteryWasDirty && batteryKey) {
        emulator.clearBatteryDirty();
      }
      this.ctx.storage.sql.exec("DELETE FROM inputs WHERE seq <= ?", before.input_seq);
      await this.pruneCheckpoints();
      return this.statusFrom(this.requireMachine());
    } catch (error) {
      this.ctx.storage.sql.exec(
        "UPDATE machine SET lifecycle = 'faulted', updated_at = ? WHERE singleton = 1",
        Date.now(),
      );
      throw error;
    }
  }

  private async ensureEmulator(row = this.requireMachine()): Promise<Emulator> {
    if (this.#emulator) {
      return this.#emulator;
    }
    if (this.#loading) {
      return await this.#loading;
    }

    this.#loading = this.restoreEmulator(row);
    try {
      this.#emulator = await this.#loading;
      return this.#emulator;
    } finally {
      this.#loading = null;
    }
  }

  private async restoreEmulator(row: MachineRow): Promise<Emulator> {
    if (!row.rom_key || !row.cartridge_hash) {
      throw new Error("No cartridge is inserted");
    }

    const romObject = await this.env.DURABLEBOY_DATA.get(row.rom_key);
    if (!romObject || romObject.size > MAX_ROM_BYTES) {
      throw new Error("Cartridge ROM is unavailable");
    }
    const emulator = await SameBoyEmulator.create(
      row.model,
      new Uint8Array(await romObject.arrayBuffer()),
    );

    try {
      if (row.battery_key) {
        const battery = await this.env.DURABLEBOY_DATA.get(row.battery_key);
        if (battery) {
          emulator.loadBattery(new Uint8Array(await battery.arrayBuffer()));
          emulator.clearBatteryDirty();
        }
      }

      const checkpoint = this.latestCheckpoint();
      let frame = 0n;
      let ticks = 0n;
      let checkpointInputSeq = 0;
      if (checkpoint) {
        const object = await this.env.DURABLEBOY_DATA.get(checkpoint.object_key);
        if (!object) {
          throw new Error("Checkpoint object is unavailable");
        }
        const state = new Uint8Array(await object.arrayBuffer());
        const digest = await sha256Hex(state);
        if (digest !== checkpoint.sha256) {
          throw new Error("Checkpoint integrity check failed");
        }
        // SameBoy save states omit the host key mask; preserve it across load hooks.
        emulator.setButtons(checkpoint.buttons);
        emulator.loadState(state);
        if (emulator.stateHash() !== checkpoint.state_hash) {
          throw new Error("SameBoy state hash does not match the checkpoint");
        }
        emulator.setButtons(checkpoint.buttons);
        frame = BigInt(checkpoint.frame);
        ticks = BigInt(checkpoint.ticks);
        checkpointInputSeq = checkpoint.input_seq;
      }

      const inputs = this.ctx.storage.sql
        .exec<InputRow>(
          "SELECT seq, frame, buttons FROM inputs WHERE seq > ? AND seq <= ? ORDER BY seq",
          checkpointInputSeq,
          row.input_seq,
        )
        .toArray();
      let inputIndex = 0;
      const targetFrame = BigInt(row.frame);
      while (frame < targetFrame) {
        while (inputIndex < inputs.length && BigInt(inputs[inputIndex]?.frame ?? "0") <= frame) {
          emulator.setButtons(inputs[inputIndex]?.buttons ?? 0);
          inputIndex += 1;
        }
        ticks += emulator.runFrame();
        frame += 1n;
      }
      while (inputIndex < inputs.length) {
        emulator.setButtons(inputs[inputIndex]?.buttons ?? 0);
        inputIndex += 1;
      }

      if (frame !== targetFrame || ticks !== BigInt(row.ticks)) {
        throw new Error("Replay clock diverged from durable metadata");
      }
      emulator.setButtons(row.buttons);
      return emulator;
    } catch (error) {
      emulator.destroy();
      throw error;
    }
  }

  private refreshLease(clientId: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE leases SET expires_at = ?
      WHERE resource = 'controller' AND owner = ?`,
      Date.now() + CONTROLLER_LEASE_MS,
      clientId,
    );
  }

  private assertLease(clientId: string, socket: WebSocket): void {
    const lease = this.ctx.storage.sql
      .exec<{ owner: string; expires_at: number }>(
        "SELECT owner, expires_at FROM leases WHERE resource = 'controller'",
      )
      .toArray()[0];
    if (!lease || lease.owner !== clientId || lease.expires_at <= Date.now()) {
      socket.close(4001, "Controller lease expired");
      throw new Error("Controller lease expired; reconnect to acquire control");
    }
  }

  private activePlayerCount(): number {
    return this.ctx.getWebSockets().filter((socket) => {
      const attachment = socketAttachment(socket);
      return socket.readyState === WebSocket.OPEN && attachment?.role === "player";
    }).length;
  }

  private promoteNextSpectator(): void {
    if (this.activePlayerCount() > 0) {
      return;
    }
    const candidate = this.ctx
      .getWebSockets()
      .filter((socket) => {
        const attachment = socketAttachment(socket);
        return (
          socket.readyState === WebSocket.OPEN &&
          attachment?.role === "spectator" &&
          attachment.wantsControl
        );
      })
      .sort(
        (left, right) =>
          (socketAttachment(left)?.connectedAt ?? 0) - (socketAttachment(right)?.connectedAt ?? 0),
      )[0];
    if (!candidate) {
      return;
    }

    const attachment = socketAttachment(candidate);
    if (!attachment) {
      return;
    }
    const now = Date.now();
    const promoted: SocketAttachment = { ...attachment, role: "player" };
    candidate.serializeAttachment(promoted);
    this.ctx.storage.sql.exec(
      `INSERT INTO leases (resource, owner, expires_at)
      VALUES ('controller', ?, ?)
      ON CONFLICT(resource) DO UPDATE SET owner = excluded.owner,
        expires_at = excluded.expires_at`,
      promoted.clientId,
      now + CONTROLLER_LEASE_MS,
    );
    this.sendJson(candidate, {
      type: "role",
      role: "player",
      status: this.statusFrom(this.requireMachine()),
    });
  }

  private async flushBattery(row: MachineRow, emulator: Emulator): Promise<string | null> {
    if (!emulator.batteryDirty() || !row.cartridge_hash) {
      return row.battery_key;
    }
    const battery = emulator.saveBattery();
    if (!battery) {
      return row.battery_key;
    }

    const key = consoleObjectKey(row.console_id, `saves/${row.cartridge_hash}.sav`);
    await this.env.DURABLEBOY_DATA.put(key, battery, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    this.ctx.storage.sql.exec(
      "UPDATE machine SET battery_key = ?, updated_at = ? WHERE singleton = 1",
      key,
      Date.now(),
    );
    emulator.clearBatteryDirty();
    return key;
  }

  private async pruneCheckpoints(): Promise<void> {
    const obsolete = this.ctx.storage.sql
      .exec<{ id: number; object_key: string }>(
        "SELECT id, object_key FROM checkpoints ORDER BY id DESC LIMIT -1 OFFSET 3",
      )
      .toArray();
    for (const checkpoint of obsolete) {
      try {
        await this.env.DURABLEBOY_DATA.delete(checkpoint.object_key);
        this.ctx.storage.sql.exec("DELETE FROM checkpoints WHERE id = ?", checkpoint.id);
      } catch (error) {
        console.warn(
          JSON.stringify({
            message: "checkpoint pruning failed",
            objectKey: checkpoint.object_key,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }

  private async deleteObjects(keys: string[]): Promise<void> {
    for (const key of new Set(keys)) {
      try {
        await this.env.DURABLEBOY_DATA.delete(key);
      } catch (error) {
        console.warn(
          JSON.stringify({
            message: "orphan checkpoint cleanup failed",
            objectKey: key,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }

  private async deleteConsolePrefix(consoleId: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const listed = await this.env.DURABLEBOY_DATA.list({
        prefix: `consoles/${consoleId}/`,
        cursor,
      });
      if (listed.objects.length > 0) {
        await this.env.DURABLEBOY_DATA.delete(listed.objects.map((object) => object.key));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  private async assertOwner(row: MachineRow, token: string): Promise<void> {
    if (!row.owner_hash || !/^[a-f0-9]{64}$/.test(row.owner_hash)) {
      throw namedError("ForbiddenError", "Owner capability is unavailable");
    }
    const tokenHash = await sha256Hex(new TextEncoder().encode(token));
    if (!constantTimeEqual(tokenHash, row.owner_hash)) {
      throw namedError("ForbiddenError", "Invalid owner capability");
    }
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private broadcastStatus(): void {
    const message: ServerMessage = {
      type: "status",
      status: this.statusFrom(this.requireMachine()),
    };
    for (const socket of this.ctx.getWebSockets()) {
      this.sendJson(socket, message);
    }
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    this.sendJson(socket, { type: "error", code, message });
  }

  private sendJson(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // Closing sockets are pruned by the runtime.
    }
  }
}

function sanitizeClientId(value: string | null): string {
  if (value && /^[a-zA-Z0-9_-]{8,80}$/.test(value)) {
    return value;
  }
  return crypto.randomUUID();
}

function socketAttachment(socket: WebSocket): SocketAttachment | null {
  const value: unknown = socket.deserializeAttachment();
  if (
    typeof value !== "object" ||
    value === null ||
    !("clientId" in value) ||
    !("role" in value) ||
    typeof value.clientId !== "string" ||
    (value.role !== "player" && value.role !== "spectator")
  ) {
    return null;
  }
  return {
    clientId: value.clientId,
    role: value.role,
    wantsControl: "wantsControl" in value ? value.wantsControl === true : value.role === "player",
    connectedAt:
      "connectedAt" in value && typeof value.connectedAt === "number" ? value.connectedAt : 0,
  };
}

function consoleObjectKey(consoleId: string, suffix: string): string {
  return `consoles/${consoleId}/${suffix}`;
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function constantTimeEqual(left: string, right: string): boolean {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}
