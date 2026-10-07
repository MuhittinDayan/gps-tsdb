import { describe, before, after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { ensureCollection, ensureIndex, setupDatabase } from '../setup.js';
import { COLLECTIONS, DAY } from '../config.js';

describe('setup.js (integration)', () => {
    let mongod, client, db;

    before(async () => {
        mongod = await MongoMemoryServer.create();
        client = new MongoClient(mongod.getUri());
        await client.connect();
        db = client.db('setup-test');
        mock.method(console, 'log', () => { });
    });

    after(async () => {
        mock.restoreAll();
        await client.close();
        await mongod.stop();
    });

    beforeEach(async () => {
        await db.dropDatabase();
    });

    describe('ensureCollection', () => {
        test('creates the collection with config options when it does not exist', async () => {
            await ensureCollection(db, 'positions', COLLECTIONS.positions.options);

            const [info] = await db.listCollections({ name: 'positions' }).toArray();
            const expected = COLLECTIONS.positions.options;
            assert.equal(info.type, 'timeseries');
            assert.equal(info.options.timeseries.timeField, expected.timeseries.timeField);
            assert.equal(info.options.timeseries.metaField, expected.timeseries.metaField);
            assert.equal(info.options.timeseries.granularity, expected.timeseries.granularity);
            assert.equal(info.options.expireAfterSeconds, expected.expireAfterSeconds);
        });

        test('creates a regular collection when no options are given', async () => {
            await ensureCollection(db, 'devices');

            const [info] = await db.listCollections({ name: 'devices' }).toArray();
            assert.equal(info.type, 'collection');
        });

        test('throws when positions exists as a regular collection but config expects time-series', async () => {
            await db.createCollection('positions');

            const options = {
                timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'seconds' },
                expireAfterSeconds: 180 * DAY,
            };
            await assert.rejects(
                ensureCollection(db, 'positions', options),
                /tür: collection, beklenen: timeseries/
            );

            const [info] = await db.listCollections({ name: 'positions' }).toArray();
            assert.equal(info.type, 'collection');
        });

        test('throws when devices exists as time-series but config expects a regular collection', async () => {
            await db.createCollection('devices', {
                timeseries: {
                    timeField: 'ts',
                    metaField: 'meta',
                    granularity: 'seconds',
                },
            });
            await assert.rejects(
                ensureCollection(db, 'devices'),
                /tür: timeseries, beklenen: collection/
            )

            const [info] = await db.listCollections({ name: 'devices' }).toArray();
            assert.equal(info.type, 'timeseries');
        })

        test('throws when positions is time-series with a different timeField', async () => {
            await db.createCollection('positions', {
                timeseries: {
                    timeField: 'timestamp',
                    metaField: 'meta',
                    granularity: 'seconds',
                },
                expireAfterSeconds: 180 * DAY
            });

            const options = {
                timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'seconds' },
                expireAfterSeconds: 180 * DAY
            }

            await assert.rejects(
                ensureCollection(db, 'positions', options),
                /timeseries\.timeField: timestamp, beklenen: ts/
            )

            const [info] = await db.listCollections({ name: 'positions' }).toArray();
            assert.equal(info.options.timeseries.timeField, 'timestamp');
        })

        test('throws when positions is time-series with a different expireAfterSeconds', async () => {
            await db.createCollection('positions', {
                timeseries: {
                    timeField: 'ts',
                    metaField: 'meta',
                    granularity: 'seconds'
                },
                expireAfterSeconds: 100 * DAY
            });
            const options = {
                timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'seconds' },
                expireAfterSeconds: COLLECTIONS.positions.options.expireAfterSeconds
            }
            await assert.rejects(
                ensureCollection(db, 'positions', options),
                new RegExp(`expireAfterSeconds: ${100 * DAY}, beklenen: ${180 * DAY}`)
            )

            const [info] = await db.listCollections({ name: 'positions' }).toArray();
            assert.equal(info.options.expireAfterSeconds, 100 * DAY);
        })

        test('accepts positions when it already exists with the config options', async () => {
            await db.createCollection('positions', {
                timeseries: {
                    timeField: 'ts',
                    metaField: 'meta',
                    granularity: 'seconds'
                },
                expireAfterSeconds: COLLECTIONS.positions.options.expireAfterSeconds
            });

            await assert.doesNotReject(
                ensureCollection(db, 'positions', COLLECTIONS.positions.options)
            );

            const [info] = await db.listCollections({ name: 'positions' }).toArray();
            const expected = COLLECTIONS.positions.options.timeseries

            assert.equal(info.type, 'timeseries');
            assert.equal(info.options.timeseries.timeField, expected.timeField);
            assert.equal(info.options.timeseries.metaField, expected.metaField);
            assert.equal(info.options.timeseries.granularity, expected.granularity);
            assert.equal(info.options.expireAfterSeconds, COLLECTIONS.positions.options.expireAfterSeconds);
        })
    });

    describe('ensureIndex', () => {
        const ttl7d = COLLECTIONS.positions.indexes.find((index) => index.name === 'ttl_7d');

        const createPositions = () => db.createCollection('positions', COLLECTIONS.positions.options);

        test('creates the index with config options when it does not exist', async () => {
            await createPositions();
            const positions = db.collection('positions');

            await ensureIndex(positions, ttl7d);

            const found = (await positions.indexes()).find((index) => index.name === 'ttl_7d');
            assert.ok(found, 'ttl_7d oluşmalı');
            assert.deepEqual(found.key, ttl7d.key);
            assert.equal(found.expireAfterSeconds, ttl7d.options.expireAfterSeconds);
            assert.deepEqual(found.partialFilterExpression, ttl7d.options.partialFilterExpression);
        });

        test('does not throw or create a second index when the same index exists', async () => {
            await createPositions();
            const positions = db.collection('positions');
            await ensureIndex(positions, ttl7d);
            const before = await positions.indexes();

            await assert.doesNotReject(ensureIndex(positions, ttl7d));

            assert.equal((await positions.indexes()).length, before.length);
        });

        test('throws and leaves the index untouched when an index with the same name has a different TTL', async () => {
            await createPositions();
            const positions = db.collection('positions');
            await positions.createIndex(ttl7d.key, { ...ttl7d.options, name: 'ttl_7d', expireAfterSeconds: 3 * DAY });

            await assert.rejects(
                ensureIndex(positions, ttl7d),
                new RegExp(`expireAfterSeconds: ${3 * DAY}, beklenen: ${7 * DAY}.*dropIndex\\('ttl_7d'\\)`)
            );

            const found = (await positions.indexes()).find((index) => index.name === 'ttl_7d');
            assert.equal(found.expireAfterSeconds, 3 * DAY);
        });

        test('throws when an index with the same name has a different partial filter', async () => {
            await createPositions();
            const positions = db.collection('positions');
            await positions.createIndex(ttl7d.key, {
                name: 'ttl_7d',
                expireAfterSeconds: ttl7d.options.expireAfterSeconds,
                partialFilterExpression: { 'meta.retentionTier': '15d' },
            });

            await assert.rejects(ensureIndex(positions, ttl7d), /partialFilterExpression/);
        });

        test('throws when an index expected to be unique is not unique', async () => {
            await db.createCollection('devices');
            const devices = db.collection('devices');
            const deviceIdIndex = COLLECTIONS.devices.indexes.find((index) => index.name === 'deviceId_1');
            await devices.createIndex(deviceIdIndex.key, { name: 'deviceId_1' });

            await assert.rejects(ensureIndex(devices, deviceIdIndex), /unique: false, beklenen: true/);
        });
    });

    describe('setupDatabase', () => {
        test('creates every collection and index from config.js on an empty database', async () => {
            await setupDatabase(db);

            for (const { name, options, indexes } of Object.values(COLLECTIONS)) {
                const [info] = await db.listCollections({ name }).toArray();
                assert.ok(info, `${name} oluşmalı`);
                assert.equal(info.type, options?.timeseries ? 'timeseries' : 'collection', `${name} türü`);

                const names = (await db.collection(name).indexes()).map((index) => index.name);
                for (const index of indexes ?? []) {
                    assert.ok(names.includes(index.name), `${name}.${index.name} oluşmalı`);
                }
            }
        });

        test('second run does not throw and changes nothing (idempotent)', async () => {
            await setupDatabase(db);
            const snapshot = async () => {
                const result = {};
                for (const { name } of Object.values(COLLECTIONS)) {
                    result[name] = (await db.collection(name).indexes()).map((index) => index.name).sort();
                }
                return result;
            };
            const first = await snapshot();

            await assert.doesNotReject(setupDatabase(db));

            assert.deepEqual(await snapshot(), first);
        });

        test('recreates a missing index without touching existing data', async () => {
            await setupDatabase(db);
            const devices = db.collection('devices');
            await devices.insertOne({ deviceId: 'DEV-1', imei: '1' });
            await db.collection('positions').dropIndex('meta.deviceId_1_ts_1');

            await setupDatabase(db);

            const names = (await db.collection('positions').indexes()).map((index) => index.name);
            assert.ok(names.includes('meta.deviceId_1_ts_1'));
            assert.equal(await devices.countDocuments(), 1);
        });
    });
});
