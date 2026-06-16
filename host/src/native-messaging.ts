// Chrome native messaging framing: 4-byte LE length header + UTF-8 JSON
// payload, both directions, over stdio. Messages host→Chrome are capped at
// 1 MB by Chrome; Chrome→host allows up to 4 GB.

export function writeNativeMessage(obj: unknown): void {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([len, json]));
}

export function readNativeMessages(
  onMessage: (msg: any) => void,
  onEnd: () => void,
): void {
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const payload = buf.subarray(4, 4 + len).toString('utf8');
      buf = buf.subarray(4 + len);
      try {
        onMessage(JSON.parse(payload));
      } catch {
        // Malformed frame from Chrome should never happen; skip it.
      }
    }
  });
  process.stdin.on('end', onEnd);
}
