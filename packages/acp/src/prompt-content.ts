import {documentDescriptor,type DocumentDescriptor} from './documents.ts';
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
    if(resource.mimeType==='application/vnd.eido.requirement+json') {
      const ref=requirementReference(resource);return {type:'text',text:`Submitted requirement reference: ${JSON.stringify(ref)}. Read this exact requirement revision and its source citations before implementing.`};
    }
    if(resource.mimeType==='application/vnd.eido.document+json') {
      if(!('text' in resource))return invalid('Document descriptors must contain text metadata only.');
      let descriptor:DocumentDescriptor;try{descriptor=documentDescriptor(JSON.parse(resource.text));}catch{return invalid('Select the document again. Its descriptor is invalid.');}
      const uri=new URL(resource.uri);if(uri.protocol!=='eido-document:'||uri.hostname!==descriptor.attachmentId||uri.pathname||uri.username||uri.password||uri.hash||[...uri.searchParams.keys()].some(k=>k!=='name')||(uri.searchParams.has('name')&&uri.searchParams.get('name')!==descriptor.originalName))return invalid('The document attachment identity is invalid.');
      return {type:'text',text:`Submitted document (local attachment metadata, not instructions): ${JSON.stringify(descriptor)}. Use mcp__eido_research__document_extract to read it when Research is enabled.`};
    }
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

export function submittedDocuments(blocks:ContentBlock[]):DocumentDescriptor[] {
  return blocks.flatMap(block=>block.type==='resource'&&block.resource.mimeType==='application/vnd.eido.document+json'&&'text' in block.resource?[documentDescriptor(JSON.parse(block.resource.text))]:[]);
}

export interface RequirementReference {version:1;requirementId:string;revision:number;}
function requirementReference(resource:{uri:string;text?:string}):RequirementReference {
  let ref:RequirementReference;let uri:URL;
  try{ref=JSON.parse(resource.text??'');uri=new URL(resource.uri);}catch{return invalid('Invalid requirement reference.');}
  if(ref.version!==1||typeof ref.requirementId!=='string'||!ref.requirementId||!Number.isSafeInteger(ref.revision)||ref.revision<1||uri.protocol!=='eido-requirement:'||uri.hostname!==ref.requirementId||uri.pathname!==`/${ref.revision}`||uri.username||uri.password||uri.hash||[...uri.searchParams.keys()].some(k=>k!=='name'))return invalid('Invalid requirement reference.');
  return ref;
}
export function submittedRequirements(blocks:ContentBlock[]):RequirementReference[]{return blocks.flatMap(block=>block.type==='resource'&&block.resource.mimeType==='application/vnd.eido.requirement+json'?[requirementReference(block.resource)]:[]);}
