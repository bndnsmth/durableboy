# Architecture

DurableBoy turns a headless SameBoy core into durable virtual hardware.

```text
Browser canvas + controls
          |
     JSON + binary WebSocket
          |
      ConsoleDO ---------------- SQLite
          |                       machine metadata
     SameBoy.wasm                 checkpoint index
          |                       input transitions
          +-------------------- R2
                                  cartridge ROM
                                  state images
                                  battery save
```

## Authority boundary

The browser renders frames, captures controls, and keeps a local list of console
IDs it has opened. It never owns emulated RAM, CPU state, virtual time, save
state, or a global console catalog.

Each console ID deterministically names one `ConsoleDO`. The object serializes
machine mutations, runs finite SameBoy frame chunks, logs input transitions,
and broadcasts the resulting framebuffer. A controller lease permits one player;
other connections observe the same authoritative machine.

## Persistence

SQLite stores compact metadata and ordered input transitions. R2 stores bounded
binary objects under `consoles/{consoleId}/`: the user ROM, SameBoy state images,
and battery-backed RAM. Full state is checkpointed periodically and on pause or
disconnect. Checkpoint completion is committed to SQLite only after the R2 write
succeeds.

Wasm memory is disposable. After eviction, the object loads the cartridge and
latest checkpoint, then replays post-checkpoint inputs to the committed virtual
frame. The replay verifier independently reconstructs the machine and compares
the SameBoy state hash.

## Virtual time

SameBoy determines frame boundaries and elapsed 8 MHz ticks. The client grants
small amounts of execution credit over the WebSocket; it does not emulate time
or mutate machine state directly. This keeps every Worker event finite while
preserving a hardware-derived virtual clock.

## No control plane

There is no global database or console listing. Recent consoles and owner
capabilities live only in the user's browser. Console deletion is routed directly
to the owning Durable Object and removes that console's R2 prefix and SQLite
storage.

## Link cable seam

The C adapter exposes SameBoy's synchronous serial callbacks and cycle-interleaved
dual-core execution. A future `LinkSessionDO` can colocate both consoles and own
their shared serial clock without changing the browser authority boundary.
