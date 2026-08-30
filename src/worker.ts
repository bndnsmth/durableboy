import { createConsoleId, isConsoleId } from "./shared/id";
import { inspectRom, MAX_ROM_BYTES, sha256Hex } from "./shared/rom";
import { ConsoleDO } from "./console-do";

export { ConsoleDO };

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const requestId = request.headers.get("X-Request-ID") ?? crypto.randomUUID();
    try {
      return await routeApi(request, env, url, requestId);
    } catch (error) {
      const apiError = normalizeError(error);
      console.error(
        JSON.stringify({
          message: "request failed",
          requestId,
          method: request.method,
          path: url.pathname,
          errorCode: apiError.code,
          error: apiError.message,
        }),
      );
      return json(
        { error: { code: apiError.code, message: apiError.message }, requestId },
        apiError.status,
        requestId,
      );
    }
  },
} satisfies ExportedHandler<Env>;

async function routeApi(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
): Promise<Response> {
  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ status: "ok", service: "durableboy" }, 200, requestId);
  }

  if (url.pathname === "/api/consoles" && request.method === "POST") {
    const body = await readJsonBody(request);
    const model = body.model === "CGB" ? "CGB" : body.model === "DMG" ? "DMG" : null;
    if (!model) {
      throw new ApiError(400, "invalid_model", "model must be DMG or CGB");
    }

    const id = createConsoleId();
    const ownerToken = createOwnerToken();
    const ownerHash = await sha256Hex(new TextEncoder().encode(ownerToken));
    const status = await env.CONSOLES.getByName(id).initialize(id, model, ownerHash);
    return json({ status, ownerToken }, 201, requestId);
  }

  const match = url.pathname.match(
    /^\/api\/consoles\/([^/]+)(?:\/(cartridge|ws|pause|checkpoint|verify))?$/,
  );
  if (!match) {
    throw new ApiError(404, "not_found", "Not found");
  }

  const consoleId = match[1] ?? "";
  const action = match[2] ?? "status";
  if (!isConsoleId(consoleId)) {
    throw new ApiError(400, "invalid_console_id", "Invalid console ID");
  }
  const console = env.CONSOLES.getByName(consoleId);

  if (action === "status" && request.method === "GET") {
    return json(await console.getStatus(), 200, requestId);
  }
  if (action === "ws" && request.method === "GET") {
    const headers = new Headers(request.headers);
    headers.set("X-Request-ID", requestId);
    return console.fetch(new Request(request, { headers }));
  }
  if (action === "pause" && request.method === "POST") {
    return json(await console.pause(), 200, requestId);
  }
  if (action === "checkpoint" && request.method === "POST") {
    return json(await console.checkpoint(), 200, requestId);
  }
  if (action === "verify" && request.method === "POST") {
    return json(await console.verifyReplay(), 200, requestId);
  }
  if (action === "cartridge" && request.method === "PUT") {
    return await insertCartridge(request, env, consoleId, requestId);
  }
  if (action === "cartridge" && request.method === "DELETE") {
    const status = await console.ejectCartridge(ownerCapability(request));
    return json(status, 200, requestId);
  }
  if (action === "status" && request.method === "DELETE") {
    await console.deleteConsole(ownerCapability(request));
    return new Response(null, {
      status: 204,
      headers: { "X-Request-ID": requestId },
    });
  }

  throw new ApiError(405, "method_not_allowed", "Method not allowed");
}

async function insertCartridge(
  request: Request,
  env: Env,
  consoleId: string,
  requestId: string,
): Promise<Response> {
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > MAX_ROM_BYTES) {
    throw new ApiError(413, "rom_too_large", "ROM exceeds the 8 MiB limit");
  }

  const ownerToken = ownerCapability(request);
  const console = env.CONSOLES.getByName(consoleId);
  const bytes = await readBoundedBody(request.body, MAX_ROM_BYTES);
  let metadata: ReturnType<typeof inspectRom>;
  try {
    metadata = inspectRom(bytes);
  } catch (error) {
    throw new ApiError(
      422,
      "invalid_rom",
      error instanceof Error ? error.message : "ROM header is invalid",
    );
  }
  const hash = await sha256Hex(bytes);
  const romKey = `consoles/${consoleId}/roms/${hash}.gb`;

  const status = await console.insertCartridge(
    {
      id: `cart_${hash.slice(0, 20)}`,
      romHash: hash,
      romKey,
      title: metadata.title,
    },
    bytes,
    ownerToken,
  );
  return json(status, 201, requestId);
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!body) {
    throw new ApiError(400, "body_required", "Request body is required");
  }

  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("ROM is too large");
        throw new ApiError(413, "rom_too_large", "ROM exceeds the 8 MiB limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readBoundedBody(request.body, 4_096);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "invalid_json", "Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function json(value: unknown, status = 200, requestId?: string): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...(requestId ? { "X-Request-ID": requestId } : {}),
    },
  });
}

function ownerCapability(request: Request): string {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new ApiError(401, "owner_capability_required", "Owner capability is required");
  }
  const token = authorization.slice("Bearer ".length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new ApiError(401, "invalid_owner_capability", "Owner capability is invalid");
  }
  return token;
}

function createOwnerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    if (error.name === "ForbiddenError") {
      return new ApiError(403, "forbidden", error.message);
    }
    if (error.message.includes("owner capability")) {
      return new ApiError(403, "forbidden", error.message);
    }
    if (error.name === "NotFoundError" || error.message.includes("does not exist")) {
      return new ApiError(404, "not_found", error.message);
    }
    if (error.name === "ConflictError" || error.message.includes("busy")) {
      return new ApiError(409, "conflict", error.message);
    }
    if (error.name === "PayloadTooLargeError") {
      return new ApiError(413, "rom_too_large", error.message);
    }
    return new ApiError(500, "internal_error", error.message);
  }
  return new ApiError(500, "internal_error", "Unknown error");
}
