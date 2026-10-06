// Each command has its own process group. IPC disconnect kills that group even
// if the native terminal force-kills the preview supervisor without a signal handler.
import {spawn} from "node:child_process";

function killGroup() {
  try { process.kill(-process.pid, "SIGKILL"); }
  catch { process.exit(1); }
}
process.on("disconnect", killGroup);
process.on("SIGTERM", killGroup);
process.on("SIGINT", killGroup);
process.on("SIGHUP", killGroup);
process.once("message", spec => {
  let finished = false;
  function finish(result) {
    if (finished) return;
    finished = true;
    if (process.connected) process.send(result, killGroup);
    else killGroup();
  }
  const child = spawn(spec.command, spec.args, {stdio: ["ignore", "inherit", "inherit"]});
  child.once("error", error => finish({exitCode: null, error: error.message}));
  child.once("exit", (exitCode, signal) => finish({exitCode, ...(signal ? {signal} : {})}));
});
