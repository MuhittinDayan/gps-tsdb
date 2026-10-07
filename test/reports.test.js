import { describe, before, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { setupDatabase } from '../setup.js';
import { COLLECTIONS, DAY } from '../config.js';
import {
    hourlyStats, overspeedEvents, offlineDevices, latePackets, gpsQuality,
    quarantineSummary, positionsNear, devicesWithin, boxPolygon,
} from '../reports.js';
import { summarizeDay, buildDailySummaries, startOfUtcDay } from '../summaries.js';

const at = (hhmm) => new Date(`2026-10-07T${hhmm}:00Z`);
const point = (lon, lat) => ({ type: 'Point', coordinates: [lon, lat] });
const range = { from: at('10:00'), to: at('12:00') };

const speedsA = [50, 60, 130, 140, 70, 125, 80];
const positionsA = speedsA.map((speed, i) => ({
    ts: at(`10:0${i}`), meta: { deviceId: 'DEV-A', vehicleId: 'VEH-A', retentionTier: '7d' },
    location: point(28.97 + i * 0.01, 41.0), speed, ignition: true, gpsValid: true, satellites: 9, hdop: 1,
}));
positionsA.push({
    ts: at('11:20'), meta: { deviceId: 'DEV-A', vehicleId: 'VEH-A', retentionTier: '7d' },
    location: point(29.2, 41.1), speed: 40, ignition: true, gpsValid: true, satellites: 9, hdop: 1,
});

const positionsB = [0, 1, 2, 3, 4].map((i) => ({
    ts: at(`10:0${i}`), meta: { deviceId: 'DEV-B', vehicleId: 'VEH-B', retentionTier: '90d' },
    location: point(29.03, 40.99 + i * 0.001), speed: 30, ignition: true, gpsValid: true, satellites: 9, hdop: 1,
}));
Object.assign(positionsB[2], { gpsValid: false, speed: 0, satellites: 1, hdop: 15 });
Object.assign(positionsB[3], { late: true, lateSeconds: 7200 });

describe('reports + daily_summaries (integration)', () => {
    let mongod, client, db;

    before(async () => {
        mongod = await MongoMemoryServer.create();
        client = new MongoClient(mongod.getUri());
        await client.connect();
        db = client.db('reports-test');
        mock.method(console, 'log', () => { });
        await setupDatabase(db);

        await db.collection(COLLECTIONS.devices.name).insertMany([
            { deviceId: 'DEV-A', imei: '1', currentVehicleId: 'VEH-A', currentTier: '7d', active: true },
            { deviceId: 'DEV-B', imei: '2', currentVehicleId: 'VEH-B', currentTier: '90d', active: true },
            { deviceId: 'DEV-C', imei: '3', currentTier: '30d', active: true },
            { deviceId: 'DEV-D', imei: '4', currentTier: '30d', active: false },
        ]);
        await db.collection(COLLECTIONS.positions.name).insertMany([...positionsA, ...positionsB]);
        await db.collection(COLLECTIONS.positionsQuarantine.name).insertMany([
            { receivedAt: at('10:30'), reason: 'K1', deviceId: 'DEV-A' },
            { receivedAt: at('10:31'), reason: 'K1', deviceId: 'DEV-B' },
            { receivedAt: at('10:32'), reason: 'G1', deviceId: 'DEV-A' },
            { receivedAt: at('13:00'), reason: 'K2', deviceId: 'DEV-A' },
        ]);
    });

    after(async () => {
        mock.restoreAll();
        await client.close();
        await mongod.stop();
    });

    test('hourlyStats: hourly message count, average and max speed (invalid GPS excluded)', async () => {
        assert.deepEqual(await hourlyStats(db, range), [
            { deviceId: 'DEV-A', hour: at('10:00'), messages: 7, avgSpeed: 93.6, maxSpeed: 140 },
            { deviceId: 'DEV-A', hour: at('11:00'), messages: 1, avgSpeed: 40, maxSpeed: 40 },
            { deviceId: 'DEV-B', hour: at('10:00'), messages: 5, avgSpeed: 30, maxSpeed: 30 },
        ]);
    });

    test('overspeedEvents: consecutive points above the limit count as one event', async () => {
        assert.deepEqual(await overspeedEvents(db, range), [
            { deviceId: 'DEV-A', events: 2, points: 3, maxSpeed: 140, firstAt: at('10:02') },
        ]);
        assert.deepEqual((await overspeedEvents(db, range, 100))[0].events, 2);
        assert.deepEqual((await overspeedEvents(db, range, 45))[0].events, 1, 'hepsi eşik üstüyse tek olay');
    });

    test('offlineDevices: active devices silent longer than the threshold or never seen', async () => {
        const offline = await offlineDevices(db, { now: at('11:30'), thresholdSeconds: 15 * 60 });
        assert.deepEqual(offline, [
            { deviceId: 'DEV-B', vehicleId: 'VEH-B', lastSeen: at('10:04'), silentSeconds: 86 * 60 },
            { deviceId: 'DEV-C', vehicleId: null, lastSeen: null, silentSeconds: null },
        ]);
    });

    test('latePackets: late measurements per device', async () => {
        assert.deepEqual(await latePackets(db, range), [
            { deviceId: 'DEV-B', latePackets: 1, avgLateSeconds: 7200, maxLateSeconds: 7200 },
        ]);
    });

    test('gpsQuality: invalid GPS ratio, average satellites and HDOP', async () => {
        assert.deepEqual(await gpsQuality(db, range), [
            { deviceId: 'DEV-A', messages: 8, invalid: 0, invalidRatio: 0, avgSatellites: 9, avgHdop: 1 },
            { deviceId: 'DEV-B', messages: 5, invalid: 1, invalidRatio: 0.2, avgSatellites: 7.4, avgHdop: 3.8 },
        ]);
    });

    test('quarantineSummary: quarantined messages in range grouped by reason', async () => {
        assert.deepEqual(await quarantineSummary(db, range), [
            { reason: 'G1', count: 1, devices: ['DEV-A'] },
            { reason: 'K1', count: 2, devices: ['DEV-A', 'DEV-B'] },
        ]);
    });

    test('positionsNear ($geoNear): valid measurements within the radius, nearest first', async () => {
        const rows = await positionsNear(db, { point: [28.97, 41.0], maxDistanceMeters: 1500, ...range });
        assert.deepEqual(rows.map((r) => [r.deviceId, r.ts]), [['DEV-A', at('10:00')], ['DEV-A', at('10:01')]]);
        assert.equal(rows[0].distanceMeters, 0);
        assert.ok(Math.abs(rows[1].distanceMeters - 839) <= 2, `mesafe ${rows[1].distanceMeters}`);
    });

    test('devicesWithin ($geoWithin): devices inside the area, invalid GPS excluded', async () => {
        const kadikoy = boxPolygon([29.0, 40.98], [29.05, 40.998]);
        assert.deepEqual(await devicesWithin(db, { polygon: kadikoy, ...range }), [
            { deviceId: 'DEV-B', points: 4, firstAt: at('10:00'), lastAt: at('10:04') },
        ]);
    });

    test('device + time query uses meta.deviceId_1_ts_1, area query uses location_2dsphere', async () => {
        const positions = db.collection(COLLECTIONS.positions.name);
        const byDevice = await positions.find({ 'meta.deviceId': 'DEV-A', ts: { $gte: range.from, $lt: range.to } }).explain();
        assert.match(JSON.stringify(byDevice), /meta\.deviceId_1_ts_1/);

        const byArea = await positions.find({ location: { $geoWithin: { $geometry: boxPolygon([29.0, 40.98], [29.05, 40.998]) } } }).explain();
        assert.match(JSON.stringify(byArea), /location_2dsphere/);
    });

    test('summarizeDay: distance, driving time, overspeed events and retention', () => {
        const summary = summarizeDay(positionsA, { date: at('10:00') });
        assert.equal(summary.deviceId, 'DEV-A');
        assert.equal(summary.vehicleId, 'VEH-A');
        assert.deepEqual(summary.date, startOfUtcDay(at('10:00')));
        assert.equal(summary.messages, 8);
        assert.equal(summary.totalKm, 5.0, '10:06 → 11:20 aralığı DRIVING_GAP_SECONDS\'tan uzun, sayılmaz');
        assert.equal(summary.drivingMinutes, 6);
        assert.equal(summary.averageSpeed, 86.9);
        assert.equal(summary.maxSpeed, 140);
        assert.equal(summary.overspeedCount, 2);
        assert.deepEqual(summary.expireAt, new Date(summary.date.getTime() + 365 * DAY * 1000));
    });

    test('summarizeDay: invalid GPS points are excluded from distance and speed, late packets are counted', () => {
        const summary = summarizeDay(positionsB);
        assert.equal(summary.invalidGps, 1);
        assert.equal(summary.latePackets, 1);
        assert.equal(summary.totalKm, 0.4);
        assert.equal(summary.drivingMinutes, 4);
        assert.equal(summary.averageSpeed, 30);
        assert.equal(summary.overspeedCount, 0);
        assert.deepEqual(summary.expireAt, new Date(summary.date.getTime() + 3 * 365 * DAY * 1000));
    });

    test('buildDailySummaries: writes one summary per device, rerun does not duplicate', async () => {
        const summaries = db.collection(COLLECTIONS.dailySummaries.name);

        const first = await buildDailySummaries(db, { date: at('15:00') });
        assert.deepEqual(first.map((s) => s.deviceId), ['DEV-A', 'DEV-B']);
        await buildDailySummaries(db, { date: at('15:00') });

        assert.equal(await summaries.countDocuments(), 2);
        const saved = await summaries.findOne({ deviceId: 'DEV-A', date: startOfUtcDay(at('10:00')) });
        assert.equal(saved.totalKm, 5.0);
        assert.equal(saved.overspeedCount, 2);
        assert.ok(saved.expireAt instanceof Date);
    });

    test('buildDailySummaries: writes nothing for a day without measurements', async () => {
        assert.deepEqual(await buildDailySummaries(db, { date: new Date('2026-10-05T00:00:00Z') }), []);
    });
});
