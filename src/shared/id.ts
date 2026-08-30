const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function createConsoleId(now = Date.now()): string {
  const random = new Uint8Array(10);
  crypto.getRandomValues(random);

  let timestamp = BigInt(now);
  let timePart = "";
  for (let index = 0; index < 10; index += 1) {
    timePart = ENCODING[Number(timestamp & 31n)] + timePart;
    timestamp >>= 5n;
  }

  let randomPart = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of random) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      randomPart += ENCODING[(accumulator >> bits) & 31];
    }
    accumulator &= (1 << bits) - 1;
  }

  return `gb_${timePart}${randomPart}`;
}

export function isConsoleId(value: string): boolean {
  return /^gb_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(value);
}
