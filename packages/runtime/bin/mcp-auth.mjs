import {piDirectory} from '../src/paths.mjs';
import {signIn} from '../src/mcp/config.mjs';
import {takeOverStdout, writeRawStdout, flushRawStdout} from '../../acp/node_modules/@earendil-works/pi-coding-agent/dist/core/output-guard.js';

// Owned by the Extensions page. EOF cancels if the page/window/app disappears.
takeOverStdout();
const send = value => writeRawStdout(JSON.stringify(value)+'\n');
const directory = piDirectory();
const stop = new AbortController();
let emergency;
const cancel = () => {
  if (stop.signal.aborted) return;
  stop.abort();
  // pi bounds discovery requests itself; this also bounds an unreachable issuer
  // during cancellation before its interactive prompt has been created.
  emergency = setTimeout(()=>process.exit(1),5_000);
};
process.once('SIGTERM',cancel);
process.stdin.once('end',cancel);
process.stdin.resume();
const deadline = setTimeout(cancel,5*60_000);
try {
  await signIn(directory,process.argv[2],{
    showAuthorizationUrl(url) {stop.signal.throwIfAborted();send({url:url.href});},
    promptForRedirectUrl(signal) {
      return new Promise(resolve=> {
        const combined = AbortSignal.any([signal,stop.signal]);
        const finish = () => resolve(undefined);
        if(combined.aborted)finish();else combined.addEventListener('abort',finish,{once:true});
      });
    },
  },stop.signal);
  send({ok:true});
} catch {
  send({ok:false,cancelled:stop.signal.aborted,error:stop.signal.aborted?'Sign-in cancelled.':'MCP sign-in failed. Check the server and OAuth configuration, then retry.'});
} finally {
  clearTimeout(deadline);clearTimeout(emergency);
  process.stdin.removeListener('end',cancel);process.stdin.pause();
  process.removeListener('SIGTERM',cancel);
  await flushRawStdout();
}
