import {createPiSettings, PiConfigError} from '../src/pi/settings.mjs';

let input = "";
try {
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 65536) throw new PiConfigError("The request is too large."); }
  const result = await createPiSettings().execute(input.trim() ? JSON.parse(input) : {});
  process.stdout.write(JSON.stringify({ ok: true, data: result }));
} catch (error) {
  // Never include raw SDK/parser diagnostics: those can contain credential values.
  const message = error instanceof PiConfigError
    ? error.message : "Unable to update pi settings. Check file formats and permissions.";
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
}
