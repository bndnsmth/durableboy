#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#include "Core/gb.h"
#include "Core/display.h"
#include "Core/joypad.h"
#include "Core/random.h"
#include "Core/save_state.h"
#include "Core/timing.h"
#include "bootroms.h"

#define DB_FRAME_WIDTH 160u
#define DB_FRAME_HEIGHT 144u
#define DB_MAX_ROM_SIZE (8u * 1024u * 1024u)
#define DB_EXPORT __attribute__((visibility("default")))

typedef struct durableboy_machine {
    GB_gameboy_t *gb;
    uint32_t *framebuffer;
    struct durableboy_machine *serial_peer;
    bool serial_output;
    bool vblank;
} durableboy_machine;

static durableboy_machine *machine_for(GB_gameboy_t *gb)
{
    return GB_get_user_data(gb);
}

static void quiet_log(GB_gameboy_t *gb, const char *message, GB_log_attributes_t attributes)
{
    (void)gb;
    (void)message;
    (void)attributes;
}

static uint32_t encode_rgba(GB_gameboy_t *gb, uint8_t red, uint8_t green, uint8_t blue)
{
    (void)gb;
    return (uint32_t)red | ((uint32_t)green << 8) | ((uint32_t)blue << 16) | 0xff000000u;
}

static void on_vblank(GB_gameboy_t *gb, GB_vblank_type_t type)
{
    (void)type;
    machine_for(gb)->vblank = true;
}

static void load_boot_rom(GB_gameboy_t *gb, GB_boot_rom_t type)
{
    switch (type) {
        case GB_BOOT_ROM_CGB_0:
        case GB_BOOT_ROM_CGB:
        case GB_BOOT_ROM_CGB_E:
            GB_load_boot_rom_from_buffer(gb, db_cgb_boot, db_cgb_boot_len);
            return;
        default:
            GB_load_boot_rom_from_buffer(gb, db_dmg_boot, db_dmg_boot_len);
            return;
    }
}

static void serial_start(GB_gameboy_t *gb, bool output)
{
    machine_for(gb)->serial_output = output;
}

static bool serial_end(GB_gameboy_t *gb)
{
    durableboy_machine *machine = machine_for(gb);
    if (!machine->serial_peer) {
        return true;
    }
    bool input = GB_serial_get_data_bit(machine->serial_peer->gb);
    GB_serial_set_data_bit(machine->serial_peer->gb, machine->serial_output);
    return input;
}

DB_EXPORT durableboy_machine *db_create(int model)
{
    durableboy_machine *machine = calloc(1, sizeof(*machine));
    if (!machine) {
        return NULL;
    }

    machine->framebuffer = calloc(DB_FRAME_WIDTH * DB_FRAME_HEIGHT, sizeof(uint32_t));
    machine->gb = GB_alloc();
    if (!machine->framebuffer || !machine->gb) {
        free(machine->framebuffer);
        if (machine->gb) {
            GB_dealloc(machine->gb);
        }
        free(machine);
        return NULL;
    }

    GB_random_set_enabled(false);
    GB_init(machine->gb, model == 1 ? GB_MODEL_CGB_E : GB_MODEL_DMG_B);
    GB_set_user_data(machine->gb, machine);
    GB_set_log_callback(machine->gb, quiet_log);
    GB_set_boot_rom_load_callback(machine->gb, load_boot_rom);
    GB_set_rgb_encode_callback(machine->gb, encode_rgba);
    GB_set_vblank_callback(machine->gb, on_vblank);
    GB_set_pixels_output(machine->gb, machine->framebuffer);
    GB_set_border_mode(machine->gb, GB_BORDER_NEVER);
    GB_set_rtc_mode(machine->gb, GB_RTC_MODE_ACCURATE);
    GB_set_palette(machine->gb, &GB_PALETTE_DMG);
    return machine;
}

DB_EXPORT void db_destroy(durableboy_machine *machine)
{
    if (!machine) {
        return;
    }
    if (machine->serial_peer) {
        machine->serial_peer->serial_peer = NULL;
        GB_disconnect_serial(machine->serial_peer->gb);
    }
    GB_free(machine->gb);
    GB_dealloc(machine->gb);
    free(machine->framebuffer);
    free(machine);
}

DB_EXPORT int db_load_rom(durableboy_machine *machine, const uint8_t *rom, size_t length)
{
    if (!machine || !rom || length < 0x150u || length > DB_MAX_ROM_SIZE) {
        return -1;
    }
    GB_load_rom_from_buffer(machine->gb, rom, length);
    GB_reset(machine->gb);
    return 0;
}

DB_EXPORT void db_reset(durableboy_machine *machine)
{
    if (machine) {
        GB_reset(machine->gb);
    }
}

DB_EXPORT void db_set_buttons(durableboy_machine *machine, uint8_t mask)
{
    if (machine) {
        GB_set_key_mask(machine->gb, (GB_key_mask_t)mask);
    }
}

DB_EXPORT uint64_t db_run_frame(durableboy_machine *machine)
{
    if (!machine) {
        return 0;
    }
    machine->vblank = false;
    uint64_t ticks = 0;
    while (!machine->vblank) {
        ticks += GB_run(machine->gb);
    }
    return ticks;
}

DB_EXPORT const uint8_t *db_framebuffer(durableboy_machine *machine)
{
    return machine ? (const uint8_t *)machine->framebuffer : NULL;
}

DB_EXPORT size_t db_framebuffer_size(durableboy_machine *machine)
{
    return machine ? DB_FRAME_WIDTH * DB_FRAME_HEIGHT * sizeof(uint32_t) : 0;
}

DB_EXPORT size_t db_state_size(durableboy_machine *machine)
{
    return machine ? GB_get_save_state_size(machine->gb) : 0;
}

DB_EXPORT int db_save_state(durableboy_machine *machine, uint8_t *destination, size_t length)
{
    if (!machine || !destination || length < GB_get_save_state_size(machine->gb)) {
        return -1;
    }
    GB_save_state_to_buffer(machine->gb, destination);
    return 0;
}

DB_EXPORT int db_load_state(durableboy_machine *machine, const uint8_t *state, size_t length)
{
    if (!machine || !state) {
        return -1;
    }
    return GB_load_state_from_buffer(machine->gb, state, length);
}

DB_EXPORT uint64_t db_state_hash(durableboy_machine *machine)
{
    if (!machine) {
        return 0;
    }
    size_t length = GB_get_save_state_size(machine->gb);
    uint8_t *state = malloc(length);
    if (!state) {
        return 0;
    }
    GB_save_state_to_buffer(machine->gb, state);

    uint64_t hash = UINT64_C(14695981039346656037);
    for (size_t index = 0; index < length; index++) {
        hash ^= state[index];
        hash *= UINT64_C(1099511628211);
    }
    free(state);
    return hash;
}

DB_EXPORT size_t db_battery_size(durableboy_machine *machine)
{
    if (!machine) {
        return 0;
    }
    int size = GB_save_battery_size(machine->gb);
    return size > 0 ? (size_t)size : 0;
}

DB_EXPORT int db_save_battery(durableboy_machine *machine, uint8_t *destination, size_t length)
{
    if (!machine || !destination) {
        return -1;
    }
    return GB_save_battery_to_buffer(machine->gb, destination, length);
}

DB_EXPORT int db_load_battery(durableboy_machine *machine, const uint8_t *battery, size_t length)
{
    if (!machine || !battery) {
        return -1;
    }
    GB_load_battery_from_buffer(machine->gb, battery, length);
    return 0;
}

DB_EXPORT int db_battery_dirty(durableboy_machine *machine)
{
    return machine && GB_get_battery_dirty(machine->gb);
}

DB_EXPORT void db_clear_battery_dirty(durableboy_machine *machine)
{
    if (machine) {
        GB_clear_battery_dirty(machine->gb);
    }
}

DB_EXPORT int db_connect_link(durableboy_machine *first, durableboy_machine *second)
{
    if (!first || !second || first == second) {
        return -1;
    }
    first->serial_peer = second;
    second->serial_peer = first;
    GB_set_serial_transfer_bit_start_callback(first->gb, serial_start);
    GB_set_serial_transfer_bit_end_callback(first->gb, serial_end);
    GB_set_serial_transfer_bit_start_callback(second->gb, serial_start);
    GB_set_serial_transfer_bit_end_callback(second->gb, serial_end);
    return 0;
}

DB_EXPORT void db_disconnect_link(durableboy_machine *machine)
{
    if (!machine || !machine->serial_peer) {
        return;
    }
    durableboy_machine *peer = machine->serial_peer;
    machine->serial_peer = NULL;
    peer->serial_peer = NULL;
    GB_disconnect_serial(machine->gb);
    GB_disconnect_serial(peer->gb);
}

DB_EXPORT uint64_t db_run_link_frame(durableboy_machine *first, durableboy_machine *second)
{
    if (!first || !second || first->serial_peer != second || second->serial_peer != first) {
        return 0;
    }

    first->vblank = false;
    second->vblank = false;
    int64_t delta = 0;
    uint64_t first_ticks = 0;
    uint64_t second_ticks = 0;
    while (!first->vblank || !second->vblank) {
        if (delta >= 0) {
            unsigned elapsed = GB_run(first->gb);
            first_ticks += elapsed;
            delta -= elapsed;
        }
        else {
            unsigned elapsed = GB_run(second->gb);
            second_ticks += elapsed;
            delta += elapsed;
        }
    }
    return (first_ticks + second_ticks) / 2;
}
