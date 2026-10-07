import { describe, before, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { SCENARIOS, generateMessages, runSimulation, createRandom } from '../simulator.js';
import { setupDatabase } from '../setup.js';
import { COLLECTIONS, OVERSPEED_KMH } from '../config.js';
import { checkLocation } from '../rules.js';

const HOUR_MS = 3600 * 1000;
const end = new Date('2026-10-07T12:00:00Z');
const start = new Date(end.getTime() - 3 * HOUR_MS);
const devices = SCENARIOS.map((_, i) => ({
    deviceId: `DEV-${1001 + i}`,
    imei: String(i + 1).padStart(15, '0'),
}));
const generate = (seed = 7) => generateMessages({ devices, start, end, intervalSeconds: 30, seed });
const ofScenario = (items, scenario) => items.filter((item) => item.scenario === scenario);

describe('simulator: message generation', () => {
    test('same seed produces the same data, a different seed different data', () => {
        assert.deepEqual(generate(7), generate(7));
        assert.notDeepEqual(generate(7), generate(8));
        const random = createRandom(1);
        for (let i = 0; i < 1000; i++) {
            const n = random();
            assert.ok(n >= 0 && n < 1);
        }
    });

    test('devices get scenarios in order, messages are sorted by receivedAt', () => {
        const items = generate();
        for (const [i, scenario] of SCENARIOS.entries()) {
            const imeis = new Set(ofScenario(items, scenario).map((item) => item.message.imei));
            assert.deepEqual([...imeis], [devices[i].imei], scenario);
        }
        for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].receivedAt <= items[i].receivedAt);
    });

    test('normal: 3 hours at 30 s = 360 messages, all valid and under the speed limit', () => {
        const normal = ofScenario(generate(), 'normal');
        assert.equal(normal.length, 360);
        for (const { message, receivedAt } of normal) {
            assert.equal(message.gpsValid, true);
            assert.ok(message.speed > 0 && message.speed <= OVERSPEED_KMH);
            assert.deepEqual(checkLocation(message.location), { ok: true });
            const delay = receivedAt - message.ts;
            assert.ok(delay >= 1000 && delay < 5000, 'normal gecikme 1–5 sn');
        }
    });

    test('park: ignition off in the middle third, speed 0, fixed location, ignition_off / ignition_on events', () => {
        const park = ofScenario(generate(), 'park').map((item) => item.message);
        const parked = park.filter((m) => m.ignition === false);
        assert.ok(parked.length >= 110 && parked.length <= 125);
        assert.ok(parked.every((m) => m.speed === 0));
        assert.equal(new Set(parked.map((m) => m.location.coordinates.join())).size, 1, 'konum sabit');
        assert.deepEqual(park.filter((m) => m.event).map((m) => m.event), ['ignition_off', 'ignition_on']);
    });

    test('overspeed: above the limit in the middle third, a single overspeed event', () => {
        const messages = ofScenario(generate(), 'overspeed').map((item) => item.message);
        const fast = messages.filter((m) => m.speed > OVERSPEED_KMH);
        assert.ok(fast.length >= 110 && fast.length <= 125);
        assert.equal(messages.filter((m) => m.event === 'overspeed').length, 1);
    });

    test('offline: messages only in the first half', () => {
        const offline = ofScenario(generate(), 'offline');
        assert.equal(offline.length, 180);
        assert.ok(offline.every(({ message }) => message.ts < new Date(start.getTime() + 1.5 * HOUR_MS)));
    });

    test('late: first third arrives at the end of the window (> 1 hour late)', () => {
        const late = ofScenario(generate(), 'late').filter(({ receivedAt }) => receivedAt.getTime() === end.getTime());
        assert.equal(late.length, 120);
        assert.ok(late.every(({ message, receivedAt }) => receivedAt - message.ts > HOUR_MS));
    });

    test('gpsLoss: middle third has gpsValid false, few satellites, high HDOP, last known location', () => {
        const messages = ofScenario(generate(), 'gpsLoss').map((item) => item.message);
        const lost = messages.filter((m) => m.gpsValid === false);
        assert.ok(lost.length >= 110 && lost.length <= 125);
        assert.ok(lost.every((m) => m.satellites < 3 && m.hdop >= 10 && m.speed === 0));
        assert.equal(new Set(lost.map((m) => m.location.coordinates.join())).size, 1);
    });

    test('badTimestamp: a K1 / K2 / K3 style bad ts is added every 15 messages', () => {
        const items = ofScenario(generate(), 'badTimestamp');
        assert.equal(items.length, 360 + 24);
        const bad = items.filter(({ message }) => !(message.ts instanceof Date) || message.ts < start || message.ts > end);
        assert.equal(bad.length, 24);
        assert.equal(bad.filter(({ message }) => message.ts === 'bozuk-zaman').length, 8);
    });

    test('duplicate: every 10th message is sent twice with the same ts', () => {
        const items = ofScenario(generate(), 'duplicate');
        assert.equal(items.length, 360 + 36);
        const unique = new Set(items.map(({ message }) => message.ts.getTime()));
        assert.equal(unique.size, 360);
    });
});

describe('simulator: writing to the database (integration)', () => {
    let mongod, client, db;

    before(async () => {
        mongod = await MongoMemoryServer.create();
        client = new MongoClient(mongod.getUri());
        await client.connect();
        db = client.db('simulator-test');
        mock.method(console, 'log', () => { });
        await setupDatabase(db);
        await db.collection(COLLECTIONS.devices.name).insertMany(devices.map((d, i) => ({
            ...d,
            currentVehicleId: `VEH-TEST-${String(i + 1).padStart(2, '0')}`,
            currentTier: '30d',
            active: true,
            installedAt: new Date('2026-09-01T09:00:00Z'),
        })));
    });

    after(async () => {
        mock.restoreAll();
        await client.close();
        await mongod.stop();
    });

    test('each scenario gets the expected result from the ingest rules', async () => {
        const result = await runSimulation(db, { hours: 3, intervalSeconds: 30, seed: 7, end });
        const { stats } = result;
        const device = (scenario) => stats.byDevice[devices[SCENARIOS.indexOf(scenario)].deviceId];

        assert.equal(result.devices, SCENARIOS.length);
        assert.equal(stats.written + stats.late + stats.duplicate + stats.quarantined, result.messages);

        assert.deepEqual(device('normal'), { written: 360, late: 0, duplicate: 0, quarantined: 0 });
        assert.deepEqual(device('offline'), { written: 180, late: 0, duplicate: 0, quarantined: 0 });
        assert.deepEqual(device('late'), { written: 240, late: 120, duplicate: 0, quarantined: 0 });
        assert.deepEqual(device('duplicate'), { written: 360, late: 0, duplicate: 36, quarantined: 0 });
        assert.deepEqual(device('badTimestamp'), { written: 360, late: 0, duplicate: 0, quarantined: 24 });
        assert.deepEqual(stats.byReason, { K1: 8, K2: 8, K3: 8 });

        const positions = db.collection(COLLECTIONS.positions.name);
        const total = await positions.countDocuments();
        assert.equal(total, stats.written + stats.late);
        assert.equal(await positions.countDocuments({ late: true }), 120);
        assert.equal(await db.collection(COLLECTIONS.positionsQuarantine.name).countDocuments(), 24);
    });
});
