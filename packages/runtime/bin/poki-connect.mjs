import {parseArgs} from 'node:util';

const {values} = parseArgs({options: {
  source: {type: 'string'}, node: {type: 'string'}, 'state-directory': {type: 'string'}, help: {type: 'boolean'},
}});
if (values.help) {
  console.log('Usage: npm run setup:poki -- --source /absolute/path/to/poki --node /absolute/path/to/node [--state-directory /absolute/path/to/state]');
  console.log('Start the installed Poki daemon first. An optional state directory must match its POKI_MCP_STATE_DIR.');
  console.log('Adds Poki to the global pi configuration used by Eido. Set EIDO_PI_CONFIG_DIR for an installed app.');
} else {
  try {
    const {createExtensionCenter} = await import('../src/pi/extensions.mjs');
    await createExtensionCenter().execute({operation: 'mcp-poki', source: values.source, node: values.node, stateDirectory: values['state-directory']});
    console.log('Poki MCP and its skill are configured. Open a new Eido task to connect, then check Extensions > MCP for connection status.');
    console.log('This registers the service; iPhone pairing, screen capture and input still need verification.');
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
