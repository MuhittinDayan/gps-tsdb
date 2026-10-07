import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, movePoint, isValidPoint } from '../geo.js';

const near = (actual, expected, tolerance, message) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual}, beklenen ~${expected}`);

test('haversine: same point is 0 m, 1° at the equator is ~111.2 km', () => {
    assert.equal(haversineMeters([28.97, 41.0], [28.97, 41.0]), 0);
    near(haversineMeters([0, 0], [1, 0]), 111195, 10, '1° boylam');
    near(haversineMeters([0, 0], [0, 1]), 111195, 10, '1° enlem');
});

test('haversine: Taksim to Kadıköy is ~6.3 km as the crow flies', () => {
    near(haversineMeters([28.9850, 41.0370], [29.0270, 40.9900]), 6340, 100, 'Taksim–Kadıköy');
});

test('movePoint: distance travelled equals the haversine distance', () => {
    for (const heading of [0, 45, 90, 180, 270, 333]) {
        const start = [28.9784, 41.0082];
        const end = movePoint(start, heading, 1500);
        near(haversineMeters(start, end), 1500, 0.01, `heading ${heading}`);
    }
});

test('movePoint: heading north changes only latitude, heading east on the equator only longitude', () => {
    const [lon1, lat1] = movePoint([28, 41], 0, 1000);
    near(lon1, 28, 1e-9, 'kuzey boylam');
    assert.ok(lat1 > 41);

    const [lon2, lat2] = movePoint([10, 0], 90, 1000);
    near(lat2, 0, 1e-9, 'doğu enlem');
    assert.ok(lon2 > 10);
});

test('isValidPoint: GeoJSON Point order is [longitude, latitude]', () => {
    assert.equal(isValidPoint({ type: 'Point', coordinates: [28.97, 41.0] }), true);
    assert.equal(isValidPoint({ type: 'Point', coordinates: [41.0, 128.97] }), false, 'enlem 90\'ı geçemez');
    assert.equal(isValidPoint(undefined), false);
});
