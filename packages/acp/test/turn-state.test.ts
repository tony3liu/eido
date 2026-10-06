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
