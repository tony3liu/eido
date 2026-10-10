import assert from 'node:assert/strict';
import {test} from 'node:test';
import {savedTurnState, terminalTurnStatus, TURN_RECORD} from '../adapter/src/turn-state.js';

test('recovery requires settlement evidence and ignores sidecars, never inferring success from assistant prose', () => {
  const entry = (status:string) => ({type:'custom',customType:TURN_RECORD,data:{version:1,id:'turn',status}});
  const sidecars = ['eido.prompt.v1','eido.delivery.v1','eido.notice.v1'].map(customType=>({type:'custom',customType,data:{status:'completed'}}));
  for (const status of ['completed','failed','cancelled']) {
    assert.equal(savedTurnState([entry('running'),entry(status),...sidecars]).status,status);
  }
  assert.equal(savedTurnState([entry('running'),...sidecars]).status,'interrupted');
  assert.equal(savedTurnState([entry('running'),{type:'custom',customType:'eido.command.result.v1',data:{status:'completed'}}]).status,'interrupted');
  assert.equal(savedTurnState([entry('running'),{type:'message',message:{role:'assistant',stopReason:'stop'}}]).status,'interrupted');
  for (const stopReason of ['stop','toolUse','length','pending']) {
    assert.equal(savedTurnState([{type:'message',message:{role:'assistant',stopReason}},...sidecars]).status,'interrupted');
  }
  assert.equal(savedTurnState([{type:'message',message:{role:'assistant',stopReason:'error'}}]).status,'failed');
  assert.equal(savedTurnState([{type:'message',message:{role:'assistant',stopReason:'aborted'}}]).status,'cancelled');
  assert.equal(savedTurnState([entry('completed'),{type:'message',message:{role:'user'}}]).status,'interrupted');
  assert.equal(savedTurnState([entry('invented')]).status,'interrupted');
  assert.equal(savedTurnState([]).status,'idle');
  assert.equal(terminalTurnStatus({response:{stopReason:'end_turn'}}),'completed');
  assert.equal(terminalTurnStatus({response:{stopReason:'cancelled'}}),'cancelled');
  for (const stopReason of ['refusal','max_tokens','max_turn_requests']) {
    assert.equal(terminalTurnStatus({response:{stopReason}}),'failed');
  }
  assert.equal(terminalTurnStatus({error:new Error('cleanup failed')}),'failed');
});


test('official tool duration survives live/replay with arbitrary plugin details and missing legacy timing', async()=> {
  const {translateEvent}=await import('../adapter/src/translate.js');
  const {replayEntry}=await import('../adapter/src/replay.js');
  for(const details of [{durationMs:'plugin-owned',nested:{retained:true}},['array',42],17,null]) {
    const result={content:[{type:'text' as const,text:'Tool result'}],details};
    const live=translateEvent({type:'tool_execution_end',toolCallId:'timed',toolName:'plugin-tool',isError:false,result,durationMs:1250.25})[0] as any;
    const replay=replayEntry({type:'message',message:{role:'toolResult',toolCallId:'timed',toolName:'plugin-tool',isError:false,...result,durationMs:1250.25}} as any)[0] as any;
    assert.deepEqual(live.rawOutput,details);assert.deepEqual(replay.rawOutput,details);
    assert.deepEqual(live._meta,{eidoToolDurationMs:1250.25});assert.deepEqual(replay._meta,live._meta);
  }
  for(const durationMs of [undefined,-1,NaN,Infinity]) {
    const replay=replayEntry({type:'message',message:{role:'toolResult',toolCallId:'legacy',content:[],durationMs}} as any)[0] as any;
    assert.equal(replay._meta,undefined);
  }
});


test('history restores file navigation without replaying a tool', async () => {
  const {replayEntry} = await import('../adapter/src/replay.js');
  for (const name of ['read', 'edit', 'write']) {
    const updates = replayEntry({type:'message', id:'history', message:{role:'assistant', content:[
      {type:'toolCall', id:name, name, arguments:{path:'src/fixture.ts'}}
    ]}} as any);
    assert.equal(updates.length, 1);
    assert.deepEqual((updates[0] as any).locations, [{path:'src/fixture.ts'}]);
    assert.equal(updates[0]?.sessionUpdate, 'tool_call');
  }
});
