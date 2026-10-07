export const MINUTE = 60;
export const HOUR = MINUTE * 60;
export const DAY = HOUR * 24;

export const TIERS = {
    '7d': { ttlSeconds: 7 * DAY, generalTTL: false },
    '15d': { ttlSeconds: 15 * DAY, generalTTL: false },
    '30d': { ttlSeconds: 30 * DAY, generalTTL: false },
    '60d': { ttlSeconds: 60 * DAY, generalTTL: false },
    '90d': { ttlSeconds: 90 * DAY, generalTTL: false },
    '180d': { ttlSeconds: 180 * DAY, generalTTL: true }
}

export const FUTURE_TOLERANCE_SECONDS = 2 * MINUTE;
export const LATE_THRESHOLD_SECONDS = HOUR;

export const INGEST_KEYS_TTL_SECONDS = 7 * DAY;
export const POSITIONS_QUARANTINE_TTL_SECONDS = 30 * DAY;

export const DEVICE_CACHE_SECONDS = MINUTE;

export const OVERSPEED_KMH = 120;
export const OFFLINE_THRESHOLD_SECONDS = 15 * MINUTE;
export const DRIVING_GAP_SECONDS = 5 * MINUTE;

export const SUMMARY_RETENTION_SECONDS = {
    '7d': 365 * DAY,
    '15d': 365 * DAY,
    '30d': 365 * DAY,
    '60d': 3 * 365 * DAY,
    '90d': 3 * 365 * DAY,
    '180d': 3 * 365 * DAY,
};

export const MEASUREMENT_FIELDS = [
    'location', 'speed', 'heading', 'ignition', 'odometer',
    'batteryVoltage', 'satellites', 'hdop', 'gpsValid', 'event',
];

const GENERAL_TIER = Object.values(TIERS).find((tier) => tier.generalTTL);

const TTL_INDEXES = [];
for (const [tierName, tier] of Object.entries(TIERS)) {
    if (tier.generalTTL) continue;
    TTL_INDEXES.push({
        name: `ttl_${tierName}`,
        key: { ts: 1 },
        options: {
            partialFilterExpression: { 'meta.retentionTier': tierName },
            expireAfterSeconds: tier.ttlSeconds,
        },
    });
}

export const COLLECTIONS = {
    devices: {
        name: 'devices',
        indexes: [
            { name: 'deviceId_1', key: { deviceId: 1 }, options: { unique: true } },
            { name: 'imei_1', key: { imei: 1 }, options: { unique: true } },
        ],
    },
    positions: {
        name: 'positions',
        options: {
            timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'seconds' },
            expireAfterSeconds: GENERAL_TIER.ttlSeconds,
        },
        indexes: [
            ...TTL_INDEXES,
            { name: 'meta.deviceId_1_ts_1', key: { 'meta.deviceId': 1, ts: 1 } },
            { name: 'location_2dsphere', key: { location: '2dsphere' } },
        ],
    },
    positionsQuarantine: {
        name: 'positions_quarantine',
        indexes: [
            { name: 'receivedAt_ttl', key: { receivedAt: 1 }, options: { expireAfterSeconds: POSITIONS_QUARANTINE_TTL_SECONDS } },
            { name: 'deviceId_1_receivedAt_1', key: { deviceId: 1, receivedAt: 1 } },
        ],
    },
    ingestKeys: {
        name: 'ingest_keys',
        indexes: [
            { name: 'deviceId_1_ts_1', key: { deviceId: 1, ts: 1 }, options: { unique: true } },
            { name: 'receivedAt_ttl', key: { receivedAt: 1 }, options: { expireAfterSeconds: INGEST_KEYS_TTL_SECONDS } },
        ],
    },
    dailySummaries: {
        name: 'daily_summaries',
        indexes: [
            { name: 'deviceId_1_date_1', key: { deviceId: 1, date: 1 }, options: { unique: true } },
            { name: 'expireAt_ttl', key: { expireAt: 1 }, options: { expireAfterSeconds: 0 } },
        ],
    },
};
