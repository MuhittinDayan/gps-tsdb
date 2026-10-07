import { MongoClient } from "mongodb";
import { pathToFileURL } from "node:url";
import { MONGO_URI, MONGO_DB } from "./env.js";
import { COLLECTIONS } from "./config.js";

export const setupDatabase = async (db) => {
    for (const { name, options, indexes } of Object.values(COLLECTIONS)) {
        await ensureCollection(db, name, options);

        const collection = db.collection(name);
        for (const index of indexes ?? []) {
            await ensureIndex(collection, index);
        }
    }
}

export const ensureCollection = async (db, name, options = {}) => {
    const existing = await db.listCollections({ name }).toArray();

    if (existing.length > 0) {
        checkCollection(existing[0], options);
        console.log(`${name} adında collection bulunmaktadır`)
    }
    else {
        await db.createCollection(name, options);
        console.log(`${name} collection oluşturuldu`)
    }
}

const checkCollection = (info, options) => {
    const problems = [];
    const wantTimeseries = options.timeseries !== undefined;
    const isTimeseries = info.type === 'timeseries';

    if (wantTimeseries !== isTimeseries) {
        problems.push(`tür: ${info.type}, beklenen: ${wantTimeseries ? 'timeseries' : 'collection'}`);
    }
    if (wantTimeseries && isTimeseries) {
        for (const field of ['timeField', 'metaField', 'granularity']) {
            const actual = info.options.timeseries[field];
            const expected = options.timeseries[field];
            if (actual !== expected) problems.push(`timeseries.${field}: ${actual}, beklenen: ${expected}`);
        }
    }
    if (info.options.expireAfterSeconds !== options.expireAfterSeconds) {
        problems.push(`expireAfterSeconds: ${info.options.expireAfterSeconds}, beklenen: ${options.expireAfterSeconds}`);
    }

    if (problems.length > 0) {
        throw new Error(`${info.name} config.js'ten farklı kurulmuş → ${problems.join('; ')}`);
    }
}

export const ensureIndex = async (collection, index) => {
    const existing = await collection.indexes();
    const found = existing.find((i) => i.name === index.name);

    if (found) {
        checkIndex(collection.collectionName, found, index);
        console.log(`  ${collection.collectionName}.${index.name} indeksi bulunmaktadır`)
    }
    else {
        await collection.createIndex(index.key, { name: index.name, ...index.options });
        console.log(`  ${collection.collectionName}.${index.name} indeksi oluşturuldu`)
    }
}

const checkIndex = (collectionName, found, index) => {
    const options = index.options ?? {};
    const problems = [];

    if (JSON.stringify(found.key) !== JSON.stringify(index.key)) {
        problems.push(`key: ${JSON.stringify(found.key)}, beklenen: ${JSON.stringify(index.key)}`);
    }
    if (Boolean(found.unique) !== Boolean(options.unique)) {
        problems.push(`unique: ${Boolean(found.unique)}, beklenen: ${Boolean(options.unique)}`);
    }
    if (found.expireAfterSeconds !== options.expireAfterSeconds) {
        problems.push(`expireAfterSeconds: ${found.expireAfterSeconds}, beklenen: ${options.expireAfterSeconds}`);
    }
    if (JSON.stringify(found.partialFilterExpression) !== JSON.stringify(options.partialFilterExpression)) {
        problems.push(`partialFilterExpression: ${JSON.stringify(found.partialFilterExpression)}, beklenen: ${JSON.stringify(options.partialFilterExpression)}`);
    }

    if (problems.length > 0) {
        throw new Error(
            `${collectionName}.${index.name} config.js'ten farklı → ${problems.join('; ')}. ` +
            `Düzeltmek için: db.${collectionName}.dropIndex('${index.name}') ve setup'ı yeniden çalıştırın`
        );
    }
}

const main = async () => {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    try {
        const db = client.db(MONGO_DB);
        console.log(`Connected : ${MONGO_URI} → ${MONGO_DB}`)

        await setupDatabase(db);
        console.log('Kurulum tamam')
    }
    finally {
        await client.close();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error('setup.js error', error.message);
        process.exitCode = 1;
    })
}
