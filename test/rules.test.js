import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDevice, checkTime, checkLocation, buildMeta, parseTs } from "../rules.js";

const device = {
    deviceId: 'DEV-1001', imei: '000000000000001',
    currentVehicleId: 'VEH-TEST-01', currentTier: '7d',
    active: true, installedAt: new Date('2026-09-01T09:00:00Z'),
};
const receivedAt = new Date('2026-09-30T10:00:00Z');

test('C1–C3: device rules', () => {
    assert.deepEqual(checkDevice(device), { ok: true });
    assert.deepEqual(checkDevice(null), { ok: false, reason: 'unknown_device' });
    assert.deepEqual(checkDevice({ ...device, active: false }), { ok: false, reason: 'inactive_device' });
    assert.deepEqual(checkDevice({ ...device, currentTier: '45d' }), { ok: false, reason: 'invalid_tier' });
    assert.deepEqual(checkDevice({ ...device, currentTier: '7D' }), { ok: false, reason: 'invalid_tier' });
    assert.deepEqual(checkDevice({ ...device, currentTier: undefined }), { ok: false, reason: 'invalid_tier' });
    assert.deepEqual(checkDevice({ ...device, currentTier: 'toString' }), { ok: false, reason: 'invalid_tier' });
});

test('C4: meta.vehicleId is null when the device is not installed in a vehicle', () => {
    assert.deepEqual(buildMeta(device), { deviceId: 'DEV-1001', vehicleId: 'VEH-TEST-01', retentionTier: '7d' });
    assert.deepEqual(buildMeta({ ...device, currentVehicleId: undefined }), { deviceId: 'DEV-1001', vehicleId: null, retentionTier: '7d' });
});

const cases = [
    ['30 Sep 09:59:55 → valid', '2026-09-30T09:59:55Z', { ok: true, late: false }],
    ['30 Sep 10:01 → valid (within tolerance)', '2026-09-30T10:01:00Z', { ok: true, late: false }],
    ['30 Sep 08:30 → valid + late', '2026-09-30T08:30:00Z', { ok: true, late: true, lateSeconds: 5400 }],
    ['27 Sep 10:00 → valid + late', '2026-09-27T10:00:00Z', { ok: true, late: true, lateSeconds: 3 * 86400 }],
    ['30 Sep 13:00 → K2', '2026-09-30T13:00:00Z', { ok: false, reason: 'K2' }],
    ['20 Sep 10:00 → K4', '2026-09-20T10:00:00Z', { ok: false, reason: 'K4' }],
    ['15 Aug 10:00 → K3', '2026-08-15T10:00:00Z', { ok: false, reason: 'K3' }],
    ['1 Jan 1970 → K3', '1970-01-01T00:00:00Z', { ok: false, reason: 'K3' }],
];

for (const [name, ts, expected] of cases) {
    test(`time rules: ${name}`, () => {
        const result = checkTime(ts, receivedAt, device);
        const { ts: _ts, ...rest } = result;
        assert.deepEqual(rest, expected);
    });
}

test('K4 depends on device tier: 10 days late on a 30d device = valid + late', () => {
    const result = checkTime('2026-09-20T10:00:00Z', receivedAt, { ...device, currentTier: '30d' });
    assert.equal(result.ok, true);
    assert.equal(result.late, true);
});

test('boundaries: exactly 2 min ahead is valid, 1 ms more is K2; exactly 1 hour is not late', () => {
    assert.equal(checkTime(new Date(receivedAt.getTime() + 120_000), receivedAt, device).ok, true);
    assert.equal(checkTime(new Date(receivedAt.getTime() + 120_001), receivedAt, device).reason, 'K2');
    assert.equal(checkTime(new Date(receivedAt.getTime() - 3_600_000), receivedAt, device).late, false);
    assert.equal(checkTime(new Date(receivedAt.getTime() - 3_600_001), receivedAt, device).late, true);
});

test('K1: ts missing or invalid', () => {
    for (const bad of [undefined, null, '', 'dün', 'not-a-date', true, NaN, {}]) {
        assert.equal(checkTime(bad, receivedAt, device).reason, 'K1', `ts=${String(bad)}`);
    }
});

test('parseTs: accepts Date, ISO string and epoch milliseconds', () => {
    const expected = new Date('2026-09-30T09:59:55Z').getTime();
    assert.equal(parseTs(new Date(expected)).getTime(), expected);
    assert.equal(parseTs('2026-09-30T09:59:55Z').getTime(), expected);
    assert.equal(parseTs(expected).getTime(), expected);
});

test('without installedAt K3 is skipped, other rules still apply', () => {
    const noInstall = { ...device, installedAt: undefined };
    assert.equal(checkTime('2026-09-30T09:59:55Z', receivedAt, noInstall).ok, true);
    assert.equal(checkTime('1970-01-01T00:00:00Z', receivedAt, noInstall).reason, 'K4');
});

test('G1: missing location is allowed, otherwise it must be a valid GeoJSON Point', () => {
    assert.deepEqual(checkLocation(undefined), { ok: true });
    assert.deepEqual(checkLocation(null), { ok: true });
    assert.deepEqual(checkLocation({ type: 'Point', coordinates: [28.9784, 41.0082] }), { ok: true });
    assert.deepEqual(checkLocation({ type: 'Point', coordinates: [-180, -90] }), { ok: true });

    const invalid = [
        { type: 'Point', coordinates: [181, 41] },
        { type: 'Point', coordinates: [28, 91] },
        { type: 'Point', coordinates: [28] },
        { type: 'Point', coordinates: ['28', '41'] },
        { type: 'Point', coordinates: [NaN, 41] },
        { type: 'LineString', coordinates: [28, 41] },
        { lat: 41, lon: 28 },
        [28, 41],
    ];
    for (const location of invalid) {
        assert.deepEqual(checkLocation(location), { ok: false, reason: 'G1' }, JSON.stringify(location));
    }
});
