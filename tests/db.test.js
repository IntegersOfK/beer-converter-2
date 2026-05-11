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

test('BC Liquor seed import preserves curated UPCs and imports per-UPC scan facts', () => {
  const now = new Date().toISOString();
  dbLayer.insertProduct({
    id: 'p_curated_test',
    name: 'Curated Lager',
    abv: 4.5,
    volumeMl: 355,
    createdAt: now,
    updatedAt: now,
  });
  dbLayer.upsertUpc({
    upc: '123456789012',
    productId: 'p_curated_test',
    flavour: 'Original',
    addedAt: now,
    updatedAt: now,
  });

  const stats = dbLayer.importBcLiquorRows([
    {
      upc: '123456789012',
      name: 'CSV SHOULD NOT WIN',
      volumeMl: 473,
      abv: 6,
      sourceSku: 'skip-me',
      category: 'Beer',
      subcategory: 'Lager',
    },
    {
      upc: '111111111111',
      name: 'SAME PRODUCT NAME',
      volumeMl: 355,
      abv: 5,
      sourceSku: 'small',
      category: 'Beer',
      subcategory: 'Ale',
    },
    {
      upc: '222222222222',
      name: 'SAME PRODUCT NAME',
      volumeMl: 650,
      abv: 5,
      sourceSku: 'large',
      category: 'Beer',
      subcategory: 'Ale',
    },
  ], 'test-bc-import');

  assert.strictEqual(stats.upcsPreserved, 1);
  assert.strictEqual(stats.upcsAdded, 2);
  assert.strictEqual(stats.productsAdded, 1);

  const byUpc = new Map(dbLayer.joinedCatalogue().map(row => [row.upc, row]));
  assert.strictEqual(byUpc.get('123456789012').name, 'Curated Lager');
  assert.strictEqual(byUpc.get('123456789012').abv, 4.5);
  assert.strictEqual(byUpc.get('123456789012').volumeMl, 355);
  assert.strictEqual(byUpc.get('111111111111').volumeMl, 355);
  assert.strictEqual(byUpc.get('222222222222').volumeMl, 650);
  assert.strictEqual(byUpc.get('222222222222').sourceSku, 'large');
});


test('BC Liquor seed file is removed after a successful one-time import', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-seed-'));
  const seedPath = path.join(dir, 'test-bc-seed-cleanup.json');
  fs.writeFileSync(seedPath, JSON.stringify([
    {
      upc: '333333333333',
      name: 'DELETE ME AFTER IMPORT',
      volumeMl: 473,
      abv: 5.5,
      sourceSku: 'cleanup',
      category: 'Beer',
      subcategory: 'Ale',
    },
  ]));

  const prevDelete = process.env.DELETE_CATALOGUE_SEED;
  process.env.DELETE_CATALOGUE_SEED = '1';
  try {
    const stats = dbLayer.migrateBcLiquorSeedIfNeeded(seedPath);
    assert.strictEqual(stats.upcsAdded, 1);
    assert.strictEqual(fs.existsSync(seedPath), false);
  } finally {
    if (prevDelete === undefined) delete process.env.DELETE_CATALOGUE_SEED;
    else process.env.DELETE_CATALOGUE_SEED = prevDelete;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
