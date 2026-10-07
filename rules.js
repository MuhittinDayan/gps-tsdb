import { TIERS, FUTURE_TOLERANCE_SECONDS, LATE_THRESHOLD_SECONDS } from "./config.js";
import { isValidPoint } from "./geo.js";

const toMs = (seconds) => seconds * 1000;

export const checkDevice = (device) => {
    if (!device) return { ok: false, reason: 'unknown_device' };
    if (device.active !== true) return { ok: false, reason: 'inactive_device' };
    if (!Object.hasOwn(TIERS, device.currentTier ?? '')) return { ok: false, reason: 'invalid_tier' };
    return { ok: true };
}

export const parseTs = (value) => {
    if (value === undefined || value === null || typeof value === 'boolean') return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

export const checkTime = (rawTs, receivedAt, device) => {
    const ts = parseTs(rawTs);
    if (!ts) return { ok: false, reason: 'K1' };

    const delayMs = receivedAt.getTime() - ts.getTime();

    if (-delayMs > toMs(FUTURE_TOLERANCE_SECONDS)) return { ok: false, reason: 'K2' };
    if (device.installedAt && ts < device.installedAt) return { ok: false, reason: 'K3' };
    if (delayMs > toMs(TIERS[device.currentTier].ttlSeconds)) return { ok: false, reason: 'K4' };

    if (delayMs > toMs(LATE_THRESHOLD_SECONDS)) {
        return { ok: true, ts, late: true, lateSeconds: Math.floor(delayMs / 1000) };
    }
    return { ok: true, ts, late: false };
}

export const checkLocation = (location) => {
    if (location === undefined || location === null) return { ok: true };
    return isValidPoint(location) ? { ok: true } : { ok: false, reason: 'G1' };
}

export const buildMeta = (device) => ({
    deviceId: device.deviceId,
    vehicleId: device.currentVehicleId ?? null,
    retentionTier: device.currentTier,
});
