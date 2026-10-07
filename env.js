import { fileURLToPath } from 'node:url';

try {
    process.loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url)));
}
catch (err) {
    if (err.code !== 'ENOENT')
        throw err;
}

export const MONGO_URI = process.env.MONGO_URI;
export const MONGO_DB = process.env.MONGO_DB;


if (!/^mongodb(\+srv)?:\/\//.test(MONGO_URI)) {
    throw new Error(`MONGO_URI geçersiz: mongodb:// veya mongodb+srv:// ile başlamalı`);
}
if (!MONGO_DB) {
    throw new Error('MONGO_DB tanımlı değil: .env dosyasına MONGO_DB=<veritabanı adı> ekleyin');
}