import {connect} from 'node:net';

// A renderer transport only: the component and agent stay in the existing pi process.
const socket = connect(process.argv[2]);
const send = value => socket.write(JSON.stringify(value) + '\n');
const dimensions = () => send({type:'resize', columns:process.stdout.columns || 80, rows:process.stdout.rows || 24});
socket.on('connect', () => {
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  dimensions();
  process.stdin.on('data', data => send({type:'input', data:data.toString('base64')}));
  process.stdout.on('resize', dimensions);
});
socket.on('data', data => {if (!process.stdout.write(data)) socket.pause();});
process.stdout.on('drain', () => socket.resume());
const close = () => {
  process.stdin.setRawMode?.(false);
  process.stdout.write('\x1b[?25h\x1b[0m');
  process.exit(0);
};
socket.on('close', close);
socket.on('error', () => {process.stderr.write('Extension interface disconnected.\n'); socket.destroy();});
process.on('SIGTERM', () => socket.destroy());
process.stdin.on('end', () => socket.destroy());
