SECTION "Entry", ROM0[$100]
    jp Main
    ds $150 - @, 0

SECTION "Program", ROM0[$150]
Main:
    di

.waitVBlank
    ldh a, [$ff44]
    cp 144
    jr c, .waitVBlank

    xor a
    ldh [$ff40], a
    ldh [$ff42], a
    ldh [$ff43], a

    ld hl, $8000
    ld b, 8
.tile
    ld a, $aa
    ld [hli], a
    xor a
    ld [hli], a
    dec b
    jr nz, .tile

    ld hl, $9800
    ld bc, 32 * 32
.map
    xor a
    ld [hli], a
    dec bc
    ld a, b
    or c
    jr nz, .map

    ld a, $e4
    ldh [$ff47], a
    ld a, $91
    ldh [$ff40], a

.forever
    jr .forever
