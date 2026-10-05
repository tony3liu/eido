import { RequestError, type ContentBlock } from '@agentclientprotocol/sdk';

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
const textTypes = new Set(['application/json', 'application/xml', 'application/javascript', 'application/typescript', 'application/yaml', 'application/toml']);
const invalid = (message: string): never => { throw new RequestError(-32602, message); };

function bytes(data: string): Uint8Array {
  if (!data || data.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return invalid('The attachment contains invalid base64 data. Attach the file again.');
  }
  const decoded = Buffer.from(data, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) {
    return invalid('The attachment contains invalid base64 data. Attach the file again.');
  }
  return decoded;
}

/** Keep inline editor snapshots and images; never fetch linked resources implicitly. */
export function preparePromptContent(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map(block => {
    if (block.type === 'audio') return invalid('pi does not accept audio attachments. Attach a transcript instead.');
    if (block.type === 'image') {
      if (!imageTypes.has(block.mimeType)) return invalid('Attach a PNG, JPEG, GIF, WebP or BMP image.');
      bytes(block.data);
      return block;
    }
    if (block.type !== 'resource') return block;
    const resource = block.resource;
    const source = `Attached resource: ${JSON.stringify(resource.uri)}`;
    if ('text' in resource) return {type: 'text', text: `${source}\n${resource.text}`};
    const mime = resource.mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (imageTypes.has(mime)) {
      bytes(resource.blob);
      return {type: 'image', data: resource.blob, mimeType: mime, uri: resource.uri};
    }
    if (!mime.startsWith('text/') && !textTypes.has(mime) && !/^application\/[\w.+-]+\+(json|xml)$/.test(mime)) {
      return invalid('pi accepts text and image attachments. Convert this file to text or images before attaching it.');
    }
    let text: string;
    try {text = new TextDecoder('utf-8', {fatal: true}).decode(bytes(resource.blob));}
    catch {return invalid('The text attachment is not valid UTF-8. Convert its encoding and attach it again.');}
    return {type: 'text', text: `${source}\n${text}`};
  });
}
