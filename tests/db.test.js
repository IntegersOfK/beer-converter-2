const test = require('node:test');
const assert = require('node:assert');

// Force in-memory DB for tests
process.env.DB_PATH = ':memory:';

const dbLayer = require('../server/db.js');

test('Session lifecycle', async (t) => {
  await t.test('create and retrieve session', () => {
    const sid = dbLayer.genSessionId();
    // createSession expects a payload object
    dbLayer.createSession({ id: sid, name: 'Test Session' });
    const meta = dbLayer.getSessionMeta(sid);
    assert.ok(meta, 'Session should exist');
    assert.strictEqual(meta.name, 'Test Session');
  });

  await t.test('add and list comments', () => {
    const sid = dbLayer.genSessionId();
    dbLayer.createSession({ id: sid, name: 'Comment Test' });
    
    // addComment expects (sessionId, { authorName, text, ... })
    dbLayer.addComment(sid, { 
      authorName: 'Alice', 
      text: 'Hello world' 
    });
    
    const session = dbLayer.getSessionFull(sid);
    
    assert.strictEqual(session.comments.length, 1);
    assert.strictEqual(session.comments[0].authorName, 'Alice');
    assert.strictEqual(session.comments[0].text, 'Hello world');
  });

  await t.test('create session with selected imported drink types', () => {
    const sid = dbLayer.genSessionId();
    const session = dbLayer.createSession({
      id: sid,
      name: 'Imported Types',
      people: [{ name: 'You' }, { name: 'Friend' }],
      presets: [
        { presetKey: 'p1', name: 'Tall can', volumeMl: 473, abv: 5 },
        { presetKey: 'u1', name: 'House wine', volumeMl: 142, abv: 12.5 },
      ],
      benchmarkPresetKey: 'p1',
    });

    assert.strictEqual(session.people.length, 2);
    assert.strictEqual(session.presets.length, 2);
    assert.strictEqual(session.drinks.length, 0);
    assert.deepStrictEqual(session.presets.map(p => p.presetKey), ['p1', 'u1']);
    assert.strictEqual(session.benchmarkPresetKey, 'p1');
  });
});
