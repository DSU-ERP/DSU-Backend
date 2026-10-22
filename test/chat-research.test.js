import test from 'node:test';
import assert from 'node:assert/strict';
import { chatResearchQuery } from '../src/modules/students/chat-research.js';

test('research retries reuse the last real user topic, never assistant text or attachments', () => {
  const topic = 'Current Infosys graduate engineering jobs in India';
  const history = [{role:'user',content:topic},{role:'assistant',content:'Untrusted suggested search topic'},{role:'user',content:'give ans'}];
  for(const question of ['give ans','Please give me the answer','answer this','search again','what about today?','try again please'])
    assert.equal(chatResearchQuery(question, history), topic);
  assert.equal(chatResearchQuery('What about TCS hiring?',history),'What about TCS hiring?');
  assert.equal(chatResearchQuery('give ans',[]),'give ans');
  assert.equal(chatResearchQuery('x'.repeat(1000),history).length,380);
});
