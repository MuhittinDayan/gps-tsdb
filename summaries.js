import { MongoClient } from "mongodb";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MONGO_URI, MONGO_DB } from "./env.js";
import { COLLECTIONS, OVERSPEED_KMH, DRIVING_GAP_SECONDS, SUMMARY_RETENTION_SECONDS, DAY } from "./config.js";
import { haversineMeters } from "./geo.js";

const round = (n, digits) => Number(n.toFixed(digits));

export const startOfUtcDay = (date) => {
    const d = new Date(date);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export const summarizeDay = (points, { date, overspeedKmh = OVERSPEED_KMH, gapSeconds = DRIVING_GAP_SECONDS } = {}) => {
    const valid = points.filter((p) => p.gpsValid === true);
    const moving = valid.filter((p) => p.speed > 0);
    const last = points.at(-1);

    let meters = 0;
    let drivingSeconds = 0;
    let overspeedCount = 0;
    let previous = null;
    for (const p of valid) {
        if (p.speed > overspeedKmh && !(previous && previous.speed > overspeedKmh)) overspeedCount += 1;
        if (previous) {
            const gap = (p.ts - previous.ts) / 1000;
            if (gap <= gapSeconds) {
                if (p.location && previous.location) meters += haversineMeters(previous.location.coordinates, p.location.coordinates);
                if (previous.ignition === true && previous.speed > 0) drivingSeconds += gap;
            }
        }
        previous = p;
    }

    const tier = last?.meta?.retentionTier;
    const day = startOfUtcDay(date ?? last.ts);
    const retention = SUMMARY_RETENTION_SECONDS[tier];
    return {
        deviceId: last.meta.deviceId,
        vehicleId: last.meta.vehicleId ?? null,
        retentionTier: tier,
        date: day,
        messages: points.length,
        invalidGps: points.length - valid.length,
        latePackets: points.filter((p) => p.late === true).length,
        totalKm: round(meters / 1000, 1),
        averageSpeed: moving.length ? round(moving.reduce((sum, p) => sum + p.speed, 0) / moving.length, 1) : 0,
        maxSpeed: valid.length ? Math.max(...valid.map((p) => p.speed ?? 0)) : 0,
        drivingMinutes: Math.round(drivingSeconds / 60),
        overspeedCount,
        expireAt: retention ? new Date(day.getTime() + retention * 1000) : null,
    };
}

export const buildDailySummaries = async (db, { date }) => {
    const from = startOfUtcDay(date);
    const to = new Date(from.getTime() + DAY * 1000);

    const points = await db.collection(COLLECTIONS.positions.name)
        .find({ ts: { $gte: from, $lt: to } })
        .sort({ 'meta.deviceId': 1, ts: 1 })
        .toArray();

    const byDevice = new Map();
    for (const p of points) {
        if (!byDevice.has(p.meta.deviceId)) byDevice.set(p.meta.deviceId, []);
        byDevice.get(p.meta.deviceId).push(p);
    }

    const summaries = [...byDevice.values()].map((devicePoints) => summarizeDay(devicePoints, { date: from }));
    const collection = db.collection(COLLECTIONS.dailySummaries.name);
    for (const summary of summaries) {
        const { deviceId, date: day, ...fields } = summary;
        if (fields.expireAt === null) delete fields.expireAt;
        await collection.updateOne(
            { deviceId, date: day },
            { $set: { ...fields, updatedAt: new Date() } },
            { upsert: true },
        );
    }
    return summaries;
}

const main = async () => {
    const { values } = parseArgs({ options: { date: { type: 'string', default: new Date().toISOString().slice(0, 10) } } });
    const date = new Date(`${values.date}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) throw new Error(`--date geçersiz: ${values.date} (YYYY-MM-DD)`);

    const client = new MongoClient(MONGO_URI);
    await client.connect();
    try {
        const db = client.db(MONGO_DB);
        console.log(`Connected : ${MONGO_URI} → ${MONGO_DB}`);
        const summaries = await buildDailySummaries(db, { date });
        console.log(`${values.date}: ${summaries.length} cihaz özeti ${COLLECTIONS.dailySummaries.name}'e yazıldı`);
        if (summaries.length > 0) {
            console.table(summaries.map(({ deviceId, totalKm, averageSpeed, maxSpeed, drivingMinutes, overspeedCount, messages, expireAt }) =>
                ({ deviceId, totalKm, averageSpeed, maxSpeed, drivingMinutes, overspeedCount, messages, expireAt: expireAt?.toISOString().slice(0, 10) })));
        }
    }
    finally {
        await client.close();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error('summaries.js error', error.message);
        process.exitCode = 1;
    })
}
