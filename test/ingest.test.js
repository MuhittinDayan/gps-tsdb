import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { MONGO_URI, MONGO_DB } from "../env.js";
import { COLLECTIONS } from "../config.js";
import { setupDatabase } from "../setup.js";
import { createIngestor } from "../ingest.js";

const TEST_DB = `${MONGO_DB}_test`;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

let client;
let db;
let ingestor;

const devices = [
    { deviceId: 'DEV-1001', imei: '000000000000001', currentVehicleId: 'VEH-TEST-01', currentTier: '7d', active: true },
    { deviceId: 'DEV-1002', imei: '000000000000002', currentVehicleId: 'VEH-TEST-02', currentTier: '30d', active: true },
    { deviceId: 'DEV-1003', imei: '000000000000003', currentVehicleId: 'VEH-TEST-03', currentTier: '7d', active: false },
    { deviceId: 'DEV-1004', imei: '000000000000004', currentVehicleId: 'VEH-TEST-04', currentTier: '45d', active: true },
    { deviceId: 'DEV-1005', imei: '000000000000005', currentTier: '15d', active: true },
];

const message = (imei, ts, extra = {}) => ({
    imei, ts,
    location: { type: 'Point', coordinates: [28.9784, 41.0082] },
    speed: 42, heading: 90, ignition: true, gpsValid: true,
    ...extra,
});

const positionsOf = (deviceId) =>
    db.collection(COLLECTIONS.positions.name).find({ 'meta.deviceId': deviceId }).sort({ ts: 1 }).toArray();

before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(TEST_DB);
    await db.dropDatabase();

    const log = console.log;
    console.log = () => {};
    try { await setupDatabase(db); } finally { console.log = log; }

    const installedAt = new Date(Date.now() - 60 * DAY_MS);
    await db.collection(COLLECTIONS.devices.name).insertMany(devices.map((d) => ({ ...d, installedAt })));
    ingestor = createIngestor(db);
});

after(async () => {
    await db.dropDatabase();
    await client.close();
});

test('valid measurement is written to positions, meta is built from devices', async () => {
    const receivedAt = new Date();
    const ts = new Date(receivedAt.getTime() - 5000);
    const result = await ingestor.ingest(message('000000000000001', ts, { retentionTier: '180d', meta: { deviceId: 'SAHTE' } }), receivedAt);
    assert.deepEqual(result, { status: 'written' });

    const [position] = await positionsOf('DEV-1001');
    assert.equal(position.ts.getTime(), ts.getTime());
    assert.deepEqual(position.meta, { deviceId: 'DEV-1001', vehicleId: 'VEH-TEST-01', retentionTier: '7d' });
    assert.equal(position.receivedAt.getTime(), receivedAt.getTime());
    assert.equal(position.speed, 42);
    assert.equal(position.late, undefined);
    assert.equal(position.retentionTier, undefined, 'mesajdaki etiket yazılmamalı');
    assert.equal(position.imei, undefined, 'MEASUREMENT_FIELDS dışındaki alan yazılmamalı');
});

test('same deviceId + ts received twice is skipped and counted as duplicate', async () => {
    const receivedAt = new Date();
    const ts = new Date(receivedAt.getTime() - 3000);
    assert.equal((await ingestor.ingest(message('000000000000001', ts), receivedAt)).status, 'written');
    assert.equal((await ingestor.ingest(message('000000000000001', ts), new Date())).status, 'duplicate');

    const same = (await positionsOf('DEV-1001')).filter((p) => p.ts.getTime() === ts.getTime());
    assert.equal(same.length, 1);
    assert.equal(ingestor.stats.byDevice['DEV-1001'].duplicate, 1);
});

test('measurement 3 days late is written and flagged late', async () => {
    const receivedAt = new Date();
    const ts = new Date(receivedAt.getTime() - 3 * DAY_MS);
    const result = await ingestor.ingest(message('000000000000001', ts), receivedAt);
    assert.deepEqual(result, { status: 'late', lateSeconds: 3 * 24 * 3600 });

    const position = (await positionsOf('DEV-1001')).find((p) => p.ts.getTime() === ts.getTime());
    assert.equal(position.late, true);
    assert.equal(position.lateSeconds, 3 * 24 * 3600);
});

test('K4 depends on device tier: 10 days late → 7d quarantined, 30d late', async () => {
    const receivedAt = new Date();
    const ts = new Date(receivedAt.getTime() - 10 * DAY_MS);
    assert.deepEqual(await ingestor.ingest(message('000000000000001', ts), receivedAt), { status: 'quarantined', reason: 'K4' });
    assert.equal((await ingestor.ingest(message('000000000000002', ts), receivedAt)).status, 'late');
});

test('C4: device not installed in a vehicle is written with vehicleId null', async () => {
    const receivedAt = new Date();
    await ingestor.ingest(message('000000000000005', new Date(receivedAt.getTime() - 1000)), receivedAt);
    const [position] = await positionsOf('DEV-1005');
    assert.equal(position.meta.vehicleId, null);
    assert.equal(position.meta.retentionTier, '15d');
});

test('quarantine: every reason is stored in positions_quarantine with the original message', async () => {
    const receivedAt = new Date();
    const ok = new Date(receivedAt.getTime() - 1000);
    const cases = [
        [message('999999999999999', ok), 'unknown_device', null],
        [message('000000000000003', ok), 'inactive_device', 'DEV-1003'],
        [message('000000000000004', ok), 'invalid_tier', 'DEV-1004'],
        [message('000000000000001', 'bozuk'), 'K1', 'DEV-1001'],
        [message('000000000000001', new Date(receivedAt.getTime() + 3 * 60 * MINUTE_MS)), 'K2', 'DEV-1001'],
        [message('000000000000001', new Date('1970-01-01T00:00:00Z')), 'K3', 'DEV-1001'],
        [message('000000000000001', ok, { location: { type: 'Point', coordinates: [200, 41] } }), 'G1', 'DEV-1001'],
    ];

    for (const [msg, reason, deviceId] of cases) {
        assert.deepEqual(await ingestor.ingest(msg, receivedAt), { status: 'quarantined', reason }, reason);
        const saved = await db.collection(COLLECTIONS.positionsQuarantine.name).findOne({ reason, receivedAt });
        assert.ok(saved, `${reason} karantinada yok`);
        assert.equal(saved.deviceId, deviceId);
        assert.equal(saved.imei, msg.imei);
        assert.equal(saved.message.speed, 42, 'orijinal mesaj saklanmalı');
    }

    assert.equal((await positionsOf('DEV-1003')).length, 0);
    assert.equal((await positionsOf('DEV-1004')).length, 0);
});

test('ingest_keys entry is rolled back when the positions write fails', async () => {
    const receivedAt = new Date();
    const ts = new Date(receivedAt.getTime() - 2000);
    const proto = Object.getPrototypeOf(db.collection(COLLECTIONS.positions.name));
    const realInsertOne = proto.insertOne;
    proto.insertOne = async function (doc, options) {
        if (this.collectionName === COLLECTIONS.positions.name) throw new Error('yazma hatası (test)');
        return realInsertOne.call(this, doc, options);
    };
    try {
        await assert.rejects(ingestor.ingest(message('000000000000002', ts), receivedAt), /yazma hatası/);
    } finally {
        proto.insertOne = realInsertOne;
    }

    const key = await db.collection(COLLECTIONS.ingestKeys.name).findOne({ deviceId: 'DEV-1002', ts });
    assert.equal(key, null, 'anahtar kalmamalı');

    assert.equal((await ingestor.ingest(message('000000000000002', ts), receivedAt)).status, 'written');
});

test('ingest_keys entry carries receivedAt (its TTL is based on it)', async () => {
    const key = await db.collection(COLLECTIONS.ingestKeys.name).findOne({ deviceId: 'DEV-1001' });
    assert.ok(key.receivedAt instanceof Date);
});

test('measurement without location (no GPS fix) is written', async () => {
    const receivedAt = new Date();
    const ts = new Date(receivedAt.getTime() - 4000);
    const { location, ...withoutLocation } = message('000000000000002', ts, { gpsValid: false });
    assert.equal((await ingestor.ingest(withoutLocation, receivedAt)).status, 'written');

    const position = (await positionsOf('DEV-1002')).find((p) => p.ts.getTime() === ts.getTime());
    assert.equal(position.location, undefined);
    assert.equal(position.gpsValid, false);
});
