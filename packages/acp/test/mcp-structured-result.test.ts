import assert from 'node:assert/strict';
import {test} from 'node:test';
import {convertMcpResult} from '../adapter/src/mcp-bridge.js';

test('MCP structured-only action handles reach the model without exposing server metadata',()=>{
  const data={snapshot_id:'snapshot-live',elements:[{label:'Test phrase',element_token:'opaque-live-handle',value:'Waiting'}]};
  const result=convertMcpResult({content:[{type:'text',text:'Text field: Test phrase'}],structuredContent:data,_meta:{private:'ui-only'}});
  const modelText=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  assert.match(modelText,/opaque-live-handle/);
  assert.deepEqual(JSON.parse(result.content[1]!.type==='text'?result.content[1]!.text:''),data);
  assert.doesNotMatch(JSON.stringify(result),/ui-only/);
  assert.deepEqual(result.details.structuredContent,data);
});

test('MCP JSON content does not repeat an already exposed structured result',()=>{
  const data={status:'ready',items:[1,2]};
  const result=convertMcpResult({content:[{type:'text',text:JSON.stringify(data,null,2)}],structuredContent:data});
  assert.equal(result.content.length,1);
});

test('MCP error structured data and original content remain observable',()=>{
  const result=convertMcpResult({isError:true,content:[{type:'text',text:'Action refused'}],structuredContent:{code:'stale_element',effect:'none'}});
  assert.equal(result.details.isError,true);
  assert.equal(result.content.length,2);
  assert.match(JSON.stringify(result.content),/stale_element/);
  const plain=convertMcpResult({content:[{type:'text',text:'Plain result'}]});
  assert.equal(plain.content.length,1);
});
