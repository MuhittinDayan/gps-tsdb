import { MongoClient } from "mongodb";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MONGO_URI, MONGO_DB } from "./env.js";
import { COLLECTIONS, OVERSPEED_KMH, LATE_THRESHOLD_SECONDS } from "./config.js";
import { createIngestor } from "./ingest.js";
import { movePoint } from "./geo.js";

export const SCENARIOS = [
    'normal',
    'park',
    'overspeed',
    'offline',
    'late',
    'gpsLoss',
    'badTimestamp',
    'duplicate',
];

const ISTANBUL = [28.9784, 41.0082];

export const createRandom = (seed) => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const round = (n, digits) => Number(n.toFixed(digits));

const generateDevice = (device, scenario, { start, end, intervalSeconds, random }) => {
    const out = [];
    const totalMs = end.getTime() - start.getTime();
    const third = (t) => (t - start.getTime()) / totalMs;

    let position = movePoint(ISTANBUL, random() * 360, random() * 15000);
    let heading = random() * 360;
    let odometer = round(10000 + random() * 90000, 1);
    let lastIgnition = null;
    let lastOverspeed = false;
    let index = 0;

    for (let t = start.getTime(); t < end.getTime(); t += intervalSeconds * 1000) {
        const progress = third(t);
        const middle = progress >= 1 / 3 && progress < 2 / 3;

        if (scenario === 'offline' && progress >= 0.5) break;

        const parked = scenario === 'park' && middle;
        const noFix = scenario === 'gpsLoss' && middle;
        const ignition = !parked;

        let speed = 0;
        if (!parked) {
            speed = scenario === 'overspeed' && middle
                ? OVERSPEED_KMH + 5 + random() * 30
                : 30 + random() * 60;
            heading = (heading + (random() - 0.5) * 30 + 360) % 360;
            const meters = (speed * 1000 / 3600) * intervalSeconds;
            if (!noFix) position = movePoint(position, heading, meters);
            odometer = round(odometer + meters / 1000, 1);
        }
        speed = round(speed, 1);

        let event;
        if (lastIgnition !== null && ignition !== lastIgnition) event = ignition ? 'ignition_on' : 'ignition_off';
        const overspeeding = speed > OVERSPEED_KMH;
        if (overspeeding && !lastOverspeed && !noFix) event = 'overspeed';
        lastIgnition = ignition;
        lastOverspeed = overspeeding;

        const message = {
            imei: device.imei,
            ts: new Date(t),
            location: { type: 'Point', coordinates: [round(position[0], 6), round(position[1], 6)] },
            speed: noFix ? 0 : speed,
            heading: round(heading, 0),
            ignition,
            odometer,
            batteryVoltage: round(ignition ? 13.6 + random() * 0.6 : 12.2 + random() * 0.5, 2),
            satellites: noFix ? Math.floor(random() * 3) : 7 + Math.floor(random() * 6),
            hdop: noFix ? round(10 + random() * 15, 1) : round(0.7 + random() * 1.3, 1),
            gpsValid: !noFix,
        };
        if (event) message.event = event;

        let receivedAt = new Date(t + 1000 + Math.floor(random() * 4000));
        if (scenario === 'late' && progress < 1 / 3) receivedAt = new Date(end.getTime());

        out.push({ message, receivedAt, scenario });

        index += 1;
        if (scenario === 'duplicate' && index % 10 === 0) {
            out.push({ message: { ...message }, receivedAt: new Date(receivedAt.getTime() + 2000), scenario });
        }
        if (scenario === 'badTimestamp' && index % 15 === 0) {
            const kind = (index / 15) % 3;
            const ts = kind === 0 ? 'bozuk-zaman'
                : kind === 1 ? new Date(receivedAt.getTime() + 24 * 3600 * 1000)
                : new Date('2020-01-01T00:00:00Z');
            out.push({ message: { ...message, ts }, receivedAt, scenario });
        }
    }
    return out;
}

export const generateMessages = ({ devices, start, end, intervalSeconds = 30, seed = 42 }) => {
    const random = createRandom(seed);
    const all = devices.flatMap((device, i) =>
        generateDevice(device, SCENARIOS[i % SCENARIOS.length], { start, end, intervalSeconds, random }));
    return all.sort((a, b) => a.receivedAt - b.receivedAt);
}

export const runSimulation = async (db, { hours = 3, intervalSeconds = 30, seed = 42, deviceLimit, end = new Date() } = {}) => {
    const query = db.collection(COLLECTIONS.devices.name).find({ active: true }).sort({ deviceId: 1 });
    if (deviceLimit) query.limit(deviceLimit);
    const devices = await query.toArray();
    if (devices.length === 0) throw new Error(`${COLLECTIONS.devices.name} içinde aktif cihaz yok`);

    if (hours * 3600 < LATE_THRESHOLD_SECONDS * 1.5) {
        console.warn(`Uyarı: ${hours} saatlik pencerede late senaryosu geç (late) işaretlenmeyebilir`);
    }

    const start = new Date(end.getTime() - hours * 3600 * 1000);
    const items = generateMessages({ devices, start, end, intervalSeconds, seed });

    const byImei = new Map();
    for (const item of items) {
        if (!byImei.has(item.message.imei)) byImei.set(item.message.imei, []);
        byImei.get(item.message.imei).push(item);
    }
    const { ingest, stats } = createIngestor(db);
    await Promise.all([...byImei.values()].map(async (queue) => {
        for (const { message, receivedAt } of queue) await ingest(message, receivedAt);
    }));

    const scenarios = Object.fromEntries(devices.map((d, i) => [d.deviceId, SCENARIOS[i % SCENARIOS.length]]));
    return { start, end, messages: items.length, devices: devices.length, scenarios, stats };
}

const main = async () => {
    const { values } = parseArgs({
        options: {
            hours: { type: 'string', default: '3' },
            interval: { type: 'string', default: '30' },
            seed: { type: 'string', default: String(Date.now() % 1e9) },
            devices: { type: 'string' },
        },
    });

    const client = new MongoClient(MONGO_URI);
    await client.connect();
    try {
        const db = client.db(MONGO_DB);
        console.log(`Connected : ${MONGO_URI} → ${MONGO_DB}`);
        const result = await runSimulation(db, {
            hours: Number(values.hours),
            intervalSeconds: Number(values.interval),
            seed: Number(values.seed),
            deviceLimit: values.devices ? Number(values.devices) : undefined,
        });

        console.log(`${result.start.toISOString()} → ${result.end.toISOString()}, ${result.devices} cihaz, ${result.messages} mesaj`);
        const { written, late, duplicate, quarantined, byReason, byDevice } = result.stats;
        console.log({ written, late, duplicate, quarantined, byReason });
        console.table(Object.entries(byDevice).sort(([a], [b]) => a.localeCompare(b)).map(([deviceId, s]) => ({ deviceId, scenario: result.scenarios[deviceId], ...s })));
    }
    finally {
        await client.close();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error('simulator.js error', error.message);
        process.exitCode = 1;
    })
}
