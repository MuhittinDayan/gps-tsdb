# Dosyalar: hangisi ne yapıyor, neden

Projenin her dosyasının görevi, içindeki fonksiyonlar ve alınan kararların nedenleri. Genel bakış için [README](../README.md).

## Akış

Bir mesajın izlediği yol:

```
simulator.js ──► ingest.js ──► rules.js (C1–C4, K1–K4, G1)
                     │
                     ├──► positions              (geçerli)
                     ├──► positions_quarantine   (kurala takılan)
                     └──► ingest_keys            (tekrar kontrolü)

positions ──► reports.js     (anlık raporlar)
          └─► summaries.js   (daily_summaries)
```

## `env.js`: bağlantı ayarları
`.env`'i kendi konumuna göre yükler, `MONGO_URI` ve `MONGO_DB`'yi dışarı verir.
- `MONGO_DB` için varsayılan değer **yok**, eksikse program durur. Böylece yanlışlıkla `test` veritabanına yazılmaz.
- Ortamlar (geliştirme, test) veritabanı adıyla ayrılır. Koleksiyon adları sabittir ve `config.js`'te durur.

## `config.js`: sistemin bütün kuralları, yalnızca veri
- **`TIERS`:** Saklama grupları (`7d` … `180d`) ve süreleri. Genel TTL'yi karşılayan grup `generalTTL: true` ile işaretli (`180d`). Geçerli etiket kontrolü (C3), K4 kuralı ve partial TTL indeksleri buradan okur.
- **Eşikler:**
  - `FUTURE_TOLERANCE_SECONDS`: ileri tarihli `ts` için tolerans, 2 dk
  - `LATE_THRESHOLD_SECONDS`: geç sayılma eşiği, 1 saat
  - `OVERSPEED_KMH`: hız sınırı, 120
  - `OFFLINE_THRESHOLD_SECONDS`: çevrimdışı sayılma süresi, 15 dk
  - `DRIVING_GAP_SECONDS`: iki nokta arası en fazla boşluk, 5 dk
- **`SUMMARY_RETENTION_SECONDS`:** Günlük özetlerin saklama süresi. `7d` / `15d` / `30d` için 1 yıl, `60d` / `90d` / `180d` için 3 yıl.
- **`COLLECTIONS`:** Bütün koleksiyonlar, ayarları ve indeksleri tek yerde. Yeni koleksiyon eklemek tek satır. `positions`'ın partial TTL indeksleri `TIERS`'tan otomatik üretilir.
- Tüm süreler **saniye**, birimi adında yazar (`ttlSeconds`, `..._SECONDS`). MongoDB'nin birimi de saniye (`expireAfterSeconds`).

## `setup.js`: kurulum (`npm run setup`)
Koleksiyonları ve indeksleri `config.js`'e göre kurar.
- **Tekrar çalıştırılabilir (idempotent):** Var olanı atlar, eksiği kurar.
- **Yanlış kurulumu sessizce geçmez:** Var olan bir koleksiyon `config.js`'ten farklıysa durur ve farkı yazar. Örnekler: `positions` time-series değil, `timeField` farklı, TTL farklı. Aynı adlı bir indeksin ayarı farklıysa da durur. Hiçbir şeyi silmez, düzeltmek için ne yapılacağını yazar.

## `rules.js`: doğrulama kuralları (veritabanına dokunmaz)
| Kod | Kural | Sonuç |
| --- | --- | --- |
| C1 | Cihaz `devices`'ta yok | Karantina `unknown_device` |
| C2 | Cihaz pasif | Karantina `inactive_device` |
| C3 | Etiket geçersiz | Karantina `invalid_tier`. Aksi halde ölçüm sessizce 180 güne düşerdi |
| C4 | Cihaz araca takılı değil | Yazılır, `vehicleId: null` |
| K1 | `ts` yok ya da okunamıyor | Karantina |
| K2 | `ts` sunucu saatinden 2 dk'dan fazla ileride | Karantina |
| K3 | `ts` cihazın kurulumundan önce | Karantina |
| K4 | `ts` cihazın saklama süresinden eski | Karantina. Zaten hemen silinecekti |
| G1 | `location` var ama geçerli bir GeoJSON Point değil | Karantina. `location_2dsphere` indeksi bozuk konumu reddeder ve yazma hata verirdi. `location` hiç yoksa (GPS fix yok) yazılır |

1 saatten fazla geç gelen ama kurallara uyan ölçüm yazılır, `late: true` ve `lateSeconds` ile işaretlenir. `meta` (`deviceId`, `vehicleId`, `retentionTier`) her zaman `devices`'tan kurulur, mesajın içinden alınmaz.

## `ingest.js`: bir mesajı işler
Sıra şöyle:
1. Cihazı `imei` ile bulur. Cihaz listesi bellekte tutulur ve 60 sn'de bir yenilenir.
2. Kuralları uygular.
3. Tekrar kontrolü yapar.
4. Ölçümü `positions`'a ya da `positions_quarantine`'e yazar.

Kararlar:
- **Tekrar kontrolü:** `ingest_keys`'te `{ deviceId, ts }` unique. Anahtar yazılamazsa mesaj tekrardır, atlanır ama sayılır. Bu kontrolü veritabanı garanti ettiği için aynı anda yazan birden fazla süreçte de doğru çalışır.
- **Geri alma:** Anahtar yazılıp ölçüm yazılamazsa anahtar geri silinir. Aksi halde cihaz aynı ölçümü yeniden gönderdiğinde tekrar sanılır ve veri kaybolur.
- **Alan filtresi:** `positions`'a yalnızca `MEASUREMENT_FIELDS`'taki alanlar kopyalanır. Mesajdaki sahte `meta` ya da yazım hatalı alanlar yazılmaz.
- **Sayaçlar:** `stats` yazılan, geç, tekrar ve karantina sayılarını nedene ve cihaza göre tutar.

```js
const { ingest, stats } = createIngestor(db);
await ingest({ imei: '000000000000001', ts: '2026-09-30T09:59:55Z', location: { type: 'Point', coordinates: [28.9784, 41.0082] }, speed: 42 });
```

`ts` için Date, ISO metin ya da epoch milisaniye kabul edilir. Sonuç şunlardan biridir:
- `{ status: 'written' }`
- `{ status: 'late', lateSeconds }`
- `{ status: 'duplicate' }`
- `{ status: 'quarantined', reason }`

## `geo.js`: coğrafi yardımcılar
- `haversineMeters([lon, lat], [lon, lat])`: iki nokta arası büyük daire mesafesi, metre. MongoDB küre yarıçapı olarak 6378.1 km kullanır, burada ortalama yarıçap (6371 km) kullanılıyor. Sonuçlar ~1 m farklı çıkabilir.
- `movePoint([lon, lat], heading, meters)`: bir noktayı verilen yönde (0° = kuzey) belirli mesafe kadar ilerletir. Simülatör araçları bununla hareket ettirir.
- `isValidPoint(location)`: GeoJSON Point kontrolü. Sıra **[boylam, enlem]**.

## `simulator.js`: test verisi üretir (`npm run simulate`)
Aktif cihazlara sırayla bir senaryo verir, mesajları üretir ve gerçek `ingest`'ten geçirir. Böylece kurallar da sınanmış olur.

| Senaryo | Ne oluyor | Beklenen sonuç |
| --- | --- | --- |
| `normal` | Baştan sona 30–90 km/h sürüş | Hepsi yazılır |
| `park` | Ortadaki üçte birde kontak kapalı, araç duruyor | `ignition_off` / `ignition_on` olayları |
| `overspeed` | Ortadaki üçte birde `OVERSPEED_KMH` üstü | Overspeed raporunda 1 olay |
| `offline` | İkinci yarıda hiç mesaj yok | Çevrimdışı raporunda görünür |
| `late` | İlk üçte birin mesajları pencerenin sonunda topluca gelir | `late: true` |
| `gpsLoss` | Ortadaki üçte birde fix yok: `gpsValid: false`, konum son bilinen | GPS kalitesi raporunda görünür |
| `badTimestamp` | Her 15 mesajda bir bozuk `ts` (K1, K2, K3 sırayla) | Karantina |
| `duplicate` | Her 10. mesaj iki kez gönderilir | Tekrar olarak sayılır, yazılmaz |

Kararlar:
- **`--seed`:** Aynı seed aynı veriyi üretir. Testler ve tekrarlanabilir denemeler için.
- **Geçmişe yazma:** `receivedAt` simüle edilir, bu yüzden 3 saatlik veri saniyeler içinde geçmişe yazılır.
- **Pencere uzunluğu:** `late` senaryosunun gerçekten geç sayılması için pencere 1.5 saatten uzun olmalı.
- **Paralel işleme:** Cihazlar paralel işlenir. Her cihazın kendi mesajları ise `receivedAt` sırasıyla işlenir.

## `reports.js`: raporlar (`npm run report`)
Ham `positions` üzerinde aggregation. Hız ve konum hesapları yalnızca `gpsValid: true` ölçümleri kullanır.

| Fonksiyon | Rapor |
| --- | --- |
| `hourlyStats` | Cihaz başına saatlik mesaj sayısı, ortalama ve en yüksek hız (`$dateTrunc`) |
| `overspeedEvents` | Hız sınırı aşımları. Arka arkaya eşik üstündeki noktalar **tek olay** sayılır (`$setWindowFields` + `$shift` ile önceki noktanın hızına bakılır) |
| `offlineDevices` | Aktif olup eşikten uzun süredir sessiz olan ya da hiç görülmemiş cihazlar |
| `latePackets` | Cihaz başına geç gelen ölçüm sayısı, ortalama ve en uzun gecikme |
| `gpsQuality` | Geçersiz GPS oranı, ortalama uydu sayısı ve HDOP |
| `quarantineSummary` | Karantinaya düşen mesajlar, nedene göre |
| `positionsNear` | Bir noktaya en yakın ölçümler (`$geoNear`) |
| `devicesWithin` | Bir bölgeye (GeoJSON Polygon) giren cihazlar (`$geoWithin`) |

Time-series'e özgü kısıtlar:
- `$near` / `$nearSphere` kullanılamaz.
- `$geoNear` pipeline'ın ilk aşaması olmalı.
- `$geoNear` içinde `query` seçeneği kabul edilmez, filtre `$match` ile sonradan yapılır.

## `summaries.js`: günlük özetler (`npm run summarize`)
Her cihaz için o günün özetini hesaplar ve `daily_summaries`'e yazar. Özette şunlar var: km, ortalama ve en yüksek hız, sürüş dakikası, overspeed olay sayısı, mesaj sayısı, geçersiz GPS sayısı, geç paket sayısı.

Kararlar:
- **Ne sayılıyor:** Mesafe ve sürüş süresi yalnızca arka arkaya iki geçerli nokta arasında, aradaki boşluk `DRIVING_GAP_SECONDS`'tan kısaysa sayılır. Cihaz uzun süre sessiz kaldıysa arada ne olduğu bilinmez.
- **Tekrar çalıştırma:** Aynı gün için tekrar çalıştırmak kaydı günceller, çoğaltmaz (`{ deviceId, date }` unique).
- **Saklama:** Ham ölçümler TTL ile silinse de özetler `expireAt`'e kadar kalır.

## `test/`: testler (`npm test`)
| Dosya | Tür | Neyi sınar |
| --- | --- | --- |
| `config.test.js` | Unit | Etiket süreleri ve adları, genel TTL, partial TTL indekslerinin anahtarı, süresi ve filtresi, özet saklama süreleri |
| `rules.test.js` | Unit | C1–C4, K1–K4, G1 ve sınır değerleri |
| `geo.test.js` | Unit | Mesafe, nokta ilerletme, GeoJSON kontrolü |
| `setup.test.js` | Integration | Koleksiyon ve indeks oluşturma, yanlış kurulumda hata, tekrar çalıştırılabilirlik |
| `ingest.test.js` | Integration | Yazma, tekrar, geç ölçüm, her karantina nedeni, hata durumunda geri alma |
| `simulator.test.js` | Unit + integration | Her senaryonun ürettiği veri ve ingest sonucu |
| `reports.test.js` | Integration | Her rapor ve özet, sonucu önceden hesaplanmış veriyle. İndekslerin gerçekten kullanıldığı explain ile kontrol ediliyor |

`npm test` gerçek `MONGO_DB`'ye dokunmaz:
- `ingest.test.js` `<MONGO_DB>_test` veritabanını kurar, kullanır ve siler.
- Diğer integration testleri `mongodb-memory-server` ile geçici bir MongoDB açar. İlk çalıştırmada mongod indirilir.

## Koleksiyonlar

| Koleksiyon | Tür | Saklama |
| --- | --- | --- |
| `devices` | Normal | Kalıcı. `deviceId` ve `imei` unique |
| `positions` | Time-series (`ts`, `meta`, `seconds`) | Genel TTL 180 gün + etiket başına partial TTL (`ttl_7d` … `ttl_90d`). Sorgu indeksi `meta.deviceId_1_ts_1`, konum indeksi `location_2dsphere` |
| `positions_quarantine` | Normal | `receivedAt`'ten 30 gün |
| `ingest_keys` | Normal | `{ deviceId, ts }` unique, `receivedAt`'ten 7 gün |
| `daily_summaries` | Normal | `{ deviceId, date }` unique, `expireAt` (1 ya da 3 yıl) |

Karantinanın ve `ingest_keys`'in TTL'si `ts`'ye değil `receivedAt`'e göre işler. İki nedeni var:
- Karantinadaki `ts` zaten güvenilmez. 1970 tarihli bir mesaj, TTL `ts`'ye göre işleseydi anında silinirdi.
- Geç gelen bir ölçümün anahtarı da `ts`'ye göre erken silinirdi.
