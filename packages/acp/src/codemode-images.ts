import {resolve, dirname, basename} from 'node:path';
import {tmpdir} from 'node:os';
import type {AgentSession} from '@earendil-works/pi-coding-agent';

type ImageOutput = {data: string; mimeType: string};
// Only paths paired with actual images in this session's official Code Mode
// result are readable. Return those recorded bytes without opening arbitrary
// temporary files or expanding native workspace write permissions.
export function codemodeImages() {
  const images = new Map<string, ImageOutput>();
  const record = (result: {content?: any[]}) => {
    const blocks = result.content ?? [];
    for (let i = 0; i < blocks.length - 1; i++) {
      const label = blocks[i], image = blocks[i + 1];
      if (label.type !== 'text' || image.type !== 'image') continue;
      const match = /(?:^|\n)\[Image saved to ([^\n]+) \(image\/(?:png|jpeg|gif|webp), [^\n]+\)\]$/.exec(label.text);
      if (!match?.[1]) continue;
      const path = resolve(match[1]);
      if (dirname(path) !== resolve(tmpdir()) || !/^pi-codemode-[a-f0-9]{16}\.(?:png|jpg|gif|webp)$/.test(basename(path))) continue;
      images.set(path, {data:image.data, mimeType:image.mimeType});
    }
  };
  return {get:(path: string) => images.get(resolve(path)), attach(session: AgentSession) {
    for (const message of session.messages) if (message.role === 'toolResult' && message.toolName === 'codemode') record(message);
    return session.subscribe(event => {
      if (event.type === 'tool_execution_end' && event.toolName === 'codemode') record(event.result);
    });
  }};
}
