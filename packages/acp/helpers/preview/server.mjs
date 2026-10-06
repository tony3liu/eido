// Product-owned static preview. Only explicitly captured inputs are served.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const [directory, owner] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
const prefix = `/${manifest.runId}/`;
const files = new Map(await Promise.all(manifest.files.map(async file => [file.path, await readFile(join(directory, "files", file.path))])));
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".txt": "text/plain" };
const server = createServer((request, response) => {
  if (request.headers.host !== `127.0.0.1:${server.address().port}`) {
    response.writeHead(403).end(); return;
  }
  if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405).end(); return; }
  let path;
  try { path = decodeURIComponent(new URL(request.url, "http://localhost").pathname); }
  catch { response.writeHead(400).end(); return; }
  const relative = path.startsWith(prefix) ? path.slice(prefix.length) : null;
  const content = files.get(relative);
  if (!content) { response.writeHead(404).end("File not included in this preview snapshot."); return; }
  response.writeHead(200, {
    "Content-Type": `${mime[extname(relative)]}; charset=utf-8`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Eido-Snapshot": manifest.fingerprint,
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  });
  response.end(request.method === "HEAD" ? undefined : content);
});
server.listen(0, "127.0.0.1", () => {
  console.log(`EIDO_PREVIEW_READY ${JSON.stringify({ runId: manifest.runId, port: server.address().port })}`);
});
// ACP owns the terminal; these bounds also cover a crashed/disconnected host.
const watchdog = setInterval(() => {
  try { process.kill(Number(owner), 0); } catch { process.exit(0); }
}, 1000);
const expiry = setTimeout(() => process.exit(0), 30 * 60 * 1000);
function stop() { clearInterval(watchdog); clearTimeout(expiry); server.closeAllConnections(); server.close(() => process.exit(0)); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
