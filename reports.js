import { MongoClient } from "mongodb";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MONGO_URI, MONGO_DB } from "./env.js";
import { COLLECTIONS, OVERSPEED_KMH, OFFLINE_THRESHOLD_SECONDS } from "./config.js";

const positionsOf = (db) => db.collection(COLLECTIONS.positions.name);
const inRange = ({ from, to }) => ({ ts: { $gte: from, $lt: to } });
const validSpeed = { $cond: [{ $eq: ['$gpsValid', true] }, '$speed', '$$REMOVE'] };

export const hourlyStats = (db, range) => positionsOf(db).aggregate([
    { $match: inRange(range) },
    {
        $group: {
            _id: { deviceId: '$meta.deviceId', hour: { $dateTrunc: { date: '$ts', unit: 'hour' } } },
            messages: { $sum: 1 },
            avgSpeed: { $avg: validSpeed },
            maxSpeed: { $max: validSpeed },
        },
    },
    { $sort: { '_id.deviceId': 1, '_id.hour': 1 } },
    {
        $project: {
            _id: 0, deviceId: '$_id.deviceId', hour: '$_id.hour', messages: '$messages',
            avgSpeed: { $round: ['$avgSpeed', 1] }, maxSpeed: '$maxSpeed',
        },
    },
]).toArray();

export const overspeedEvents = (db, range, limitKmh = OVERSPEED_KMH) => positionsOf(db).aggregate([
    { $match: { ...inRange(range), gpsValid: true } },
    {
        $setWindowFields: {
            partitionBy: '$meta.deviceId',
            sortBy: { ts: 1 },
            output: { previousSpeed: { $shift: { output: '$speed', by: -1, default: 0 } } },
        },
    },
    { $match: { speed: { $gt: limitKmh } } },
    {
        $group: {
            _id: '$meta.deviceId',
            events: { $sum: { $cond: [{ $lte: ['$previousSpeed', limitKmh] }, 1, 0] } },
            points: { $sum: 1 },
            maxSpeed: { $max: '$speed' },
            firstAt: { $min: '$ts' },
        },
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, deviceId: '$_id', events: '$events', points: '$points', maxSpeed: '$maxSpeed', firstAt: '$firstAt' } },
]).toArray();

export const offlineDevices = async (db, { now = new Date(), thresholdSeconds = OFFLINE_THRESHOLD_SECONDS } = {}) => {
    const devices = await db.collection(COLLECTIONS.devices.name)
        .find({ active: true }, { projection: { _id: 0, deviceId: 1, currentVehicleId: 1 } })
        .sort({ deviceId: 1 }).toArray();
    const lastSeen = await positionsOf(db).aggregate([
        { $match: { ts: { $lte: now } } },
        { $group: { _id: '$meta.deviceId', lastSeen: { $max: '$ts' } } },
    ]).toArray();
    const lastById = new Map(lastSeen.map((d) => [d._id, d.lastSeen]));

    return devices
        .map(({ deviceId, currentVehicleId }) => {
            const seen = lastById.get(deviceId) ?? null;
            const silentSeconds = seen ? Math.floor((now - seen) / 1000) : null;
            return { deviceId, vehicleId: currentVehicleId ?? null, lastSeen: seen, silentSeconds };
        })
        .filter((d) => d.lastSeen === null || d.silentSeconds > thresholdSeconds);
}

export const latePackets = (db, range) => positionsOf(db).aggregate([
    { $match: { ...inRange(range), late: true } },
    {
        $group: {
            _id: '$meta.deviceId',
            latePackets: { $sum: 1 },
            avgLateSeconds: { $avg: '$lateSeconds' },
            maxLateSeconds: { $max: '$lateSeconds' },
        },
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, deviceId: '$_id', latePackets: '$latePackets', avgLateSeconds: { $round: ['$avgLateSeconds', 0] }, maxLateSeconds: '$maxLateSeconds' } },
]).toArray();

export const gpsQuality = (db, range) => positionsOf(db).aggregate([
    { $match: inRange(range) },
    {
        $group: {
            _id: '$meta.deviceId',
            messages: { $sum: 1 },
            invalid: { $sum: { $cond: [{ $eq: ['$gpsValid', true] }, 0, 1] } },
            avgSatellites: { $avg: '$satellites' },
            avgHdop: { $avg: '$hdop' },
        },
    },
    { $sort: { _id: 1 } },
    {
        $project: {
            _id: 0, deviceId: '$_id', messages: '$messages', invalid: '$invalid',
            invalidRatio: { $round: [{ $divide: ['$invalid', '$messages'] }, 3] },
            avgSatellites: { $round: ['$avgSatellites', 1] },
            avgHdop: { $round: ['$avgHdop', 2] },
        },
    },
]).toArray();

export const quarantineSummary = (db, { from, to }) => db.collection(COLLECTIONS.positionsQuarantine.name).aggregate([
    { $match: { receivedAt: { $gte: from, $lt: to } } },
    { $group: { _id: '$reason', count: { $sum: 1 }, devices: { $addToSet: '$deviceId' } } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, reason: '$_id', count: '$count', devices: { $sortArray: { input: '$devices', sortBy: 1 } } } },
]).toArray();

export const positionsNear = (db, { point, maxDistanceMeters, from, to, limit = 10 }) => positionsOf(db).aggregate([
    {
        $geoNear: {
            near: { type: 'Point', coordinates: point },
            key: 'location',
            distanceField: 'distanceMeters',
            maxDistance: maxDistanceMeters,
            spherical: true,
        },
    },
    { $match: { ...inRange({ from, to }), gpsValid: true } },
    { $limit: limit },
    { $project: { _id: 0, deviceId: '$meta.deviceId', ts: '$ts', location: '$location', speed: '$speed', distanceMeters: { $round: ['$distanceMeters', 0] } } },
]).toArray();

export const devicesWithin = (db, { polygon, from, to }) => positionsOf(db).aggregate([
    { $match: { ...inRange({ from, to }), gpsValid: true, location: { $geoWithin: { $geometry: polygon } } } },
    { $group: { _id: '$meta.deviceId', points: { $sum: 1 }, firstAt: { $min: '$ts' }, lastAt: { $max: '$ts' } } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, deviceId: '$_id', points: '$points', firstAt: '$firstAt', lastAt: '$lastAt' } },
]).toArray();

export const boxPolygon = ([minLon, minLat], [maxLon, maxLat]) => ({
    type: 'Polygon',
    coordinates: [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]],
});

const main = async () => {
    const { values } = parseArgs({
        options: {
            hours: { type: 'string', default: '24' },
            near: { type: 'string', default: '28.9784,41.0082' },
            radius: { type: 'string', default: '3000' },
        },
    });
    const to = new Date();
    const from = new Date(to.getTime() - Number(values.hours) * 3600 * 1000);
    const range = { from, to };
    const point = values.near.split(',').map(Number);

    const client = new MongoClient(MONGO_URI);
    await client.connect();
    try {
        const db = client.db(MONGO_DB);
        console.log(`Connected : ${MONGO_URI} → ${MONGO_DB}`);
        console.log(`Aralık: ${from.toISOString()} → ${to.toISOString()}\n`);

        const sections = [
            ['Saatlik hız ve mesaj sayısı', () => hourlyStats(db, range)],
            [`Overspeed (> ${OVERSPEED_KMH} km/h)`, () => overspeedEvents(db, range)],
            [`Çevrimdışı cihazlar (> ${OFFLINE_THRESHOLD_SECONDS / 60} dk sessiz)`, () => offlineDevices(db, { now: to })],
            ['Geç gelen paketler', () => latePackets(db, range)],
            ['GPS kalitesi', () => gpsQuality(db, range)],
            ['Karantina', () => quarantineSummary(db, range)],
            [`${point.join(',')} çevresinde ${values.radius} m ($geoNear)`, () => positionsNear(db, { point, maxDistanceMeters: Number(values.radius), ...range })],
            [`${point.join(',')} etrafındaki 0.1° kutuya giren cihazlar ($geoWithin)`, () => devicesWithin(db, {
                polygon: boxPolygon([point[0] - 0.05, point[1] - 0.05], [point[0] + 0.05, point[1] + 0.05]), ...range,
            })],
        ];
        for (const [title, run] of sections) {
            const rows = await run();
            console.log(`## ${title} (${rows.length})`);
            const printable = rows.map((row) => (row.location ? { ...row, location: row.location.coordinates.join(', ') } : row));
            if (printable.length > 0) console.table(printable);
            console.log();
        }
    }
    finally {
        await client.close();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error('reports.js error', error.message);
        process.exitCode = 1;
    })
}
