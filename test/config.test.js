import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DAY,
    TIERS,
    COLLECTIONS,
    SUMMARY_RETENTION_SECONDS,
} from '../config.js';

const ttlIndexesOf = (collection) => collection.indexes.filter((index) => index.name.startsWith('ttl_'));

test('TIERS has exactly one generalTTL tier', () => {
    const allTiers = Object.values(TIERS);
    const generalTiers = allTiers.filter((tier) => tier.generalTTL === true);
    assert.equal(generalTiers.length, 1);
});

test('every tier name has the form <days>d and its duration matches that number of days', () => {
    for (const [name, value] of Object.entries(TIERS)) {
        assert.match(name, /^\d+d$/, `${name} tier adı <gün>d biçiminde olmalı`);
        const days = parseInt(name, 10);
        assert.equal(value.ttlSeconds, days * DAY, `${name} tier süresi yanlış`);
    }
});

test('general tier has the longest retention', () => {
    const allTiers = Object.entries(TIERS);
    const [, generalTier] = allTiers.find(([, tier]) => tier.generalTTL === true);

    for (const [name, tier] of allTiers) {
        if (tier.generalTTL) continue;

        assert.ok(
            tier.ttlSeconds < generalTier.ttlSeconds,
            `${name} tier'ı genel tier'dan kısa olmalı`
        );
    }
});

test('positions collection TTL equals the general tier duration', () => {
    const generalTier = Object.values(TIERS).find((tier) => tier.generalTTL === true);
    const collectionTTL = COLLECTIONS.positions.options.expireAfterSeconds;
    assert.equal(generalTier.ttlSeconds, collectionTTL);
});

test('one partial TTL index per tier, none for the general tier', () => {
    const ttlIndexes = ttlIndexesOf(COLLECTIONS.positions);
    const nonGeneralTiers = Object.values(TIERS).filter((tier) => !tier.generalTTL);
    assert.equal(ttlIndexes.length, nonGeneralTiers.length);

    for (const [tierName, tier] of Object.entries(TIERS)) {
        if (!tier.generalTTL) continue;
        assert.equal(
            ttlIndexes.find((index) => index.name === `ttl_${tierName}`),
            undefined,
            `${tierName} genel TTL'ye bırakılmalı, ayrı indeksi olmamalı`
        );
    }
});

test('partial TTL indexes use the right key, duration and tier filter', () => {
    const ttlIndexes = ttlIndexesOf(COLLECTIONS.positions);
    const timeField = COLLECTIONS.positions.options.timeseries.timeField;

    for (const [tierName, tier] of Object.entries(TIERS)) {
        if (tier.generalTTL) continue;

        const ttlIndex = ttlIndexes.find(
            (index) => index.name === `ttl_${tierName}`
        );

        assert.ok(ttlIndex, `${tierName} için index bulunamadı.`);
        assert.deepEqual(ttlIndex.key, { [timeField]: 1 }, `${tierName} indeksi timeField üzerinde olmalı`);
        assert.equal(
            ttlIndex.options.expireAfterSeconds,
            tier.ttlSeconds,
            `${tierName} TTL süresi yanlış`
        );
        assert.equal(
            ttlIndex.options.partialFilterExpression['meta.retentionTier'],
            tierName,
            `${tierName} filtresi yanlış`
        );
    }
});

test('every tier has a daily summary retention longer than its raw data retention', () => {
    for (const [tierName, tier] of Object.entries(TIERS)) {
        const summaryRetention = SUMMARY_RETENTION_SECONDS[tierName];
        assert.ok(summaryRetention, `${tierName} için özet saklama süresi yok`);
        assert.ok(summaryRetention > tier.ttlSeconds, `${tierName} özetleri ham veriden uzun saklanmalı`);
    }
});
