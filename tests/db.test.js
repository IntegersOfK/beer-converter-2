const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    const comment = dbLayer.addComment(sid, {
      authorName: 'Alice',
      text: 'Hello world'
    });

    const session = dbLayer.getSessionFull(sid);

    assert.strictEqual(session.comments.length, 1);
    assert.strictEqual(session.comments[0].authorName, 'Alice');
    assert.strictEqual(session.comments[0].text, 'Hello world');

    assert.strictEqual(dbLayer.removeComment(sid, comment.id), true);
    assert.strictEqual(dbLayer.getSessionFull(sid).comments.length, 0);
  });

  await t.test('comment reactions preserve optional author names', () => {
    const sid = dbLayer.genSessionId();
    dbLayer.createSession({ id: sid, name: 'Reaction Test' });
    const comment = dbLayer.addComment(sid, {
      authorName: 'Alice',
      text: 'Cheers',
    });

    assert.strictEqual(dbLayer.toggleReaction(sid, comment.id, {
      deviceId: 'dev_named',
      authorName: 'Bob',
      emoji: '🍻',
    }), true);
    assert.strictEqual(dbLayer.toggleReaction(sid, comment.id, {
      deviceId: 'dev_anon',
      emoji: '🍻',
    }), true);

    const reactions = dbLayer.getSessionFull(sid).reactions;
    assert.strictEqual(reactions.length, 2);
    assert.ok(reactions.some(r => r.authorName === 'Bob'));
    assert.ok(reactions.some(r => r.authorName == null));

    assert.strictEqual(dbLayer.toggleReaction(sid, comment.id, {
      deviceId: 'dev_named',
      authorName: 'Bob',
      emoji: '🍻',
    }), true);
    assert.strictEqual(dbLayer.getSessionFull(sid).reactions.length, 1);
  });

  await t.test('drink activity events capture add and remove', () => {
    const sid = dbLayer.genSessionId();
    const session = dbLayer.createSession({
      id: sid,
      name: 'Activity Test',
      people: [{ name: 'Alice' }],
    });

    const drink = dbLayer.addDrink(sid, {
      personId: session.people[0].id,
      name: 'Pint',
      volumeMl: 568,
      abv: 5,
      t: 123,
    });

    let full = dbLayer.getSessionFull(sid);
    assert.strictEqual(full.events.length, 1);
    assert.strictEqual(full.events[0].type, 'drink_added');
    assert.strictEqual(full.events[0].data.personName, 'Alice');
    assert.strictEqual(full.events[0].data.drinkName, 'Pint');

    assert.strictEqual(dbLayer.removeDrink(sid, drink.id), true);
    full = dbLayer.getSessionFull(sid);
    assert.strictEqual(full.events.length, 2);
    assert.deepStrictEqual(full.events.map(e => e.type), ['drink_added', 'drink_removed']);
    assert.strictEqual(full.events[1].data.drinkName, 'Pint');
  });


  await t.test('cocktail drinks persist component UPCs and effective ABV', () => {
    const sid = dbLayer.genSessionId();
    const session = dbLayer.createSession({
      id: sid,
      name: 'Cocktail Test',
      people: [{ name: 'Alice' }],
    });

    const drink = dbLayer.addDrink(sid, {
      personId: session.people[0].id,
      name: 'Martini',
      inputKind: 'cocktail',
      components: [
        { name: 'Gin', volumeMl: 60, abv: 40, upc: '123456789012' },
        { name: 'Vermouth', volumeMl: 15, abv: 16, upc: '999888777666' },
      ],
      t: 456,
    });

    assert.strictEqual(drink.inputKind, 'cocktail');
    assert.strictEqual(drink.volumeMl, 75);
    assert.strictEqual(drink.abv, 35.2);
    assert.strictEqual(drink.components.length, 2);
    assert.strictEqual(drink.components[0].upc, '123456789012');

    const full = dbLayer.getSessionFull(sid);
    assert.strictEqual(full.drinks[0].inputKind, 'cocktail');
    assert.deepStrictEqual(full.drinks[0].components.map(c => c.name), ['Gin', 'Vermouth']);
    assert.strictEqual(full.events[0].data.inputKind, 'cocktail');
    assert.strictEqual(full.events[0].data.components[1].upc, '999888777666');

    const updated = dbLayer.updateDrink(sid, drink.id, {
      name: 'Bigger Martini',
      inputKind: 'cocktail',
      components: [
        { name: 'Gin', volumeMl: 75, abv: 40, upc: '123456789012' },
        { name: 'Vermouth', volumeMl: 15, abv: 16, upc: '999888777666' },
      ],
      unlinkPreset: true,
    });

    assert.strictEqual(updated.name, 'Bigger Martini');
    assert.strictEqual(updated.volumeMl, 90);
    assert.strictEqual(updated.abv, 36);
    assert.deepStrictEqual(updated.components.map(c => c.volumeMl), [75, 15]);
  });


  await t.test('cocktail presets persist components and re-link drinks on cascade', () => {
    const sid = dbLayer.genSessionId();
    const session = dbLayer.createSession({
      id: sid,
      name: 'Cocktail Preset Test',
      people: [{ name: 'Alice' }],
    });

    const preset = dbLayer.upsertPreset(sid, {
      presetKey: 'u_negroni',
      name: 'Negroni',
      inputKind: 'cocktail',
      components: [
        { name: 'Gin', volumeMl: 30, abv: 40, upc: '111111111111' },
        { name: 'Campari', volumeMl: 30, abv: 24 },
        { name: 'Vermouth', volumeMl: 30, abv: 16 },
      ],
    });

    assert.strictEqual(preset.inputKind, 'cocktail');
    assert.strictEqual(preset.components.length, 3);
    assert.strictEqual(preset.volumeMl, 90);
    assert.ok(Math.abs(preset.abv - 26.67) < 0.05, `expected ~26.67 ABV, got ${preset.abv}`);

    const drink = dbLayer.addDrink(sid, {
      personId: session.people[0].id,
      presetKey: preset.presetKey,
      name: preset.name,
      inputKind: 'cocktail',
      components: preset.components,
      t: 1,
    });

    let full = dbLayer.getSessionFull(sid);
    assert.strictEqual(full.presets.length, 1);
    assert.strictEqual(full.presets[0].inputKind, 'cocktail');
    assert.strictEqual(full.presets[0].components[0].upc, '111111111111');
    assert.strictEqual(full.drinks[0].inputKind, 'cocktail');

    // Cascade-edit the preset (bump the gin pour). Linked drink should follow.
    const next = dbLayer.updatePresetCascade(sid, preset.presetKey, {
      name: 'Negroni Forte',
      inputKind: 'cocktail',
      components: [
        { name: 'Gin', volumeMl: 60, abv: 40, upc: '111111111111' },
        { name: 'Campari', volumeMl: 30, abv: 24 },
        { name: 'Vermouth', volumeMl: 30, abv: 16 },
      ],
    });
    assert.strictEqual(next.name, 'Negroni Forte');
    assert.strictEqual(next.volumeMl, 120);
    assert.strictEqual(next.components[0].volumeMl, 60);

    full = dbLayer.getSessionFull(sid);
    const linked = full.drinks.find(d => d.id === drink.id);
    assert.strictEqual(linked.name, 'Negroni Forte');
    assert.strictEqual(linked.volumeMl, 120);
    assert.strictEqual(linked.inputKind, 'cocktail');
    assert.strictEqual(linked.components[0].volumeMl, 60);
  });

  await t.test('deleting a preset unlinks existing drinks', () => {
    const sid = dbLayer.genSessionId();
    const session = dbLayer.createSession({
      id: sid,
      name: 'Preset Delete Test',
      people: [{ name: 'Alice' }],
      presets: [
        { presetKey: 'u_lager', name: 'House lager', volumeMl: 473, abv: 5 },
        { presetKey: 'u_wine', name: 'House wine', volumeMl: 142, abv: 12 },
      ],
      benchmarkPresetKey: 'u_lager',
    });

    const drink = dbLayer.addDrink(sid, {
      personId: session.people[0].id,
      presetKey: 'u_lager',
      name: 'House lager',
      volumeMl: 473,
      abv: 5,
      t: 99,
    });

    assert.strictEqual(dbLayer.removePreset(sid, 'u_lager'), true);

    const full = dbLayer.getSessionFull(sid);
    assert.deepStrictEqual(full.presets.map(p => p.presetKey), ['u_wine']);
    const unlinked = full.drinks.find(d => d.id === drink.id);
    assert.ok(unlinked);
    assert.strictEqual(unlinked.presetKey, null);
    assert.strictEqual(unlinked.name, 'House lager');
  });

  await t.test('create and list database backups', async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beer-converter-backups-'));
    process.env.BACKUP_DIR = backupDir;

    const backup = await dbLayer.createBackup({ label: 'Before Pull!' });
    const backups = dbLayer.listBackups();

    assert.match(backup.filename, /^data-.*-before-pull\.db$/);
    assert.ok(backup.size > 0);
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(backups[0].filename, backup.filename);
    assert.strictEqual(dbLayer.backupPath(backup.filename), path.join(backupDir, backup.filename));
    assert.strictEqual(dbLayer.backupPath('../data.db'), null);
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
