import {createExtensionCenter} from '../src/pi/extensions.mjs';
import {bundledPiEntry as entry} from '../src/paths.mjs';

const {takeOverStdout, writeRawStdout, flushRawStdout} = await import(new URL("core/output-guard.js", entry).href);
takeOverStdout();
try {
  let text = ""; for await (const part of process.stdin) {text += part; if (text.length > 1_000_000) throw new Error("Request is too large.");}
  const data = await createExtensionCenter().execute(text ? JSON.parse(text) : {});
  writeRawStdout(JSON.stringify({ok: true, data}));
} catch (error) {writeRawStdout(JSON.stringify({ok: false, error: error.message})); process.exitCode = 1;}
await flushRawStdout();
