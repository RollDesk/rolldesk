// Minimal ClamAV client speaking clamd's INSTREAM protocol over TCP, so we can
// scan an uploaded file (held in memory) without shelling out to a binary or
// pulling in a dependency.
//
// INSTREAM framing: send "zINSTREAM\0", then one or more chunks of
// <uint32 big-endian length><bytes>, then a zero-length chunk (four 0 bytes) to
// signal the end. clamd replies with e.g. "stream: OK\0" or
// "stream: <Signature> FOUND\0".
import net from 'node:net';
import { config } from './config.js';

const CHUNK = 64 * 1024;

export function avEnabled() {
  return !!config.av.host;
}

// Scans a Buffer. Resolves { clean: boolean, virus: string|null } or rejects if
// the scan couldn't be completed (connection/timeout/protocol error).
export function scanBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let response = '';
    let settled = false;

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(arg);
    };

    socket.setTimeout(config.av.timeoutMs);
    socket.on('timeout', () => done(reject, new Error('clamd scan timed out')));
    socket.on('error', (err) => done(reject, err));
    socket.on('data', (data) => { response += data.toString('utf8'); });
    socket.on('close', () => {
      const text = response.replace(/\0/g, '').trim();
      if (!text) return done(reject, new Error('empty response from clamd'));
      if (/\bOK$/.test(text)) return done(resolve, { clean: true, virus: null });
      const found = text.match(/^stream:\s*(.+?)\s+FOUND$/i);
      if (found) return done(resolve, { clean: false, virus: found[1] });
      // Anything else (e.g. "INSTREAM size limit exceeded", "ERROR") is a failure.
      done(reject, new Error('clamd error: ' + text));
    });

    socket.connect(config.av.port, config.av.host, () => {
      socket.write('zINSTREAM\0');
      for (let offset = 0; offset < buffer.length; offset += CHUNK) {
        const slice = buffer.subarray(offset, Math.min(offset + CHUNK, buffer.length));
        const size = Buffer.alloc(4);
        size.writeUInt32BE(slice.length, 0);
        socket.write(size);
        socket.write(slice);
      }
      // Zero-length chunk terminates the stream.
      socket.write(Buffer.from([0, 0, 0, 0]));
    });
  });
}
