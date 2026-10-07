import { COLLECTIONS, DEVICE_CACHE_SECONDS, MEASUREMENT_FIELDS } from "./config.js";
import { checkDevice, checkTime, checkLocation, buildMeta } from "./rules.js";

const DUPLICATE_KEY = 11000;

export const createDeviceCache = (db) => {
    const devices = db.collection(COLLECTIONS.devices.name);
    let byImei = new Map();
    let loadedAt = 0;

    const refresh = async () => {
        const all = await devices.find({}).toArray();
        byImei = new Map(all.map((device) => [device.imei, device]));
        loadedAt = Date.now();
    }

    return {
        refresh,
        get: async (imei) => {
            if (Date.now() - loadedAt > DEVICE_CACHE_SECONDS * 1000) await refresh();
            return byImei.get(imei) ?? null;
        },
    };
}

export const createIngestor = (db, { deviceCache = createDeviceCache(db) } = {}) => {
    const positions = db.collection(COLLECTIONS.positions.name);
    const quarantine = db.collection(COLLECTIONS.positionsQuarantine.name);
    const ingestKeys = db.collection(COLLECTIONS.ingestKeys.name);

    const stats = { written: 0, late: 0, duplicate: 0, quarantined: 0, byReason: {}, byDevice: {} };
    const count = (status, deviceKey, reason) => {
        stats[status] += 1;
        if (reason) stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1;
        const perDevice = (stats.byDevice[deviceKey] ??= { written: 0, late: 0, duplicate: 0, quarantined: 0 });
        perDevice[status] += 1;
    }

    const toQuarantine = async (message, receivedAt, device, reason) => {
        await quarantine.insertOne({
            receivedAt,
            reason,
            deviceId: device?.deviceId ?? null,
            imei: message?.imei ?? null,
            message,
        });
        count('quarantined', device?.deviceId ?? message?.imei ?? 'unknown', reason);
        return { status: 'quarantined', reason };
    }

    const ingest = async (message, receivedAt = new Date()) => {
        const device = await deviceCache.get(message?.imei);
        const deviceCheck = checkDevice(device);
        if (!deviceCheck.ok) return toQuarantine(message, receivedAt, device, deviceCheck.reason);

        const timeCheck = checkTime(message.ts, receivedAt, device);
        if (!timeCheck.ok) return toQuarantine(message, receivedAt, device, timeCheck.reason);
        const { ts, late, lateSeconds } = timeCheck;

        const locationCheck = checkLocation(message.location);
        if (!locationCheck.ok) return toQuarantine(message, receivedAt, device, locationCheck.reason);

        const key = { deviceId: device.deviceId, ts, receivedAt };
        try {
            await ingestKeys.insertOne(key);
        } catch (error) {
            if (error.code === DUPLICATE_KEY) {
                count('duplicate', device.deviceId);
                return { status: 'duplicate' };
            }
            throw error;
        }

        const position = { ts, meta: buildMeta(device) };
        for (const field of MEASUREMENT_FIELDS) {
            if (message[field] !== undefined) position[field] = message[field];
        }
        position.receivedAt = receivedAt;
        if (late) {
            position.late = true;
            position.lateSeconds = lateSeconds;
        }

        try {
            await positions.insertOne(position);
        } catch (error) {
            await ingestKeys.deleteOne({ _id: key._id });
            throw error;
        }

        const status = late ? 'late' : 'written';
        count(status, device.deviceId);
        return late ? { status, lateSeconds } : { status };
    }

    return { ingest, stats };
}
