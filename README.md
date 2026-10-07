# MongoDB Time-Series for GPS Telematics

Araç takip cihazlarından gelen GPS verisinin MongoDB time-series koleksiyonlarında nasıl saklanacağını, farklı müşteri paketlerine göre nasıl farklı sürelerde silineceğini ve nasıl raporlanacağını adım adım deneyen bir öğrenme projesi.

Örnek veriler bilerek sahte seçildi: IMEI `000000000000001`, plaka `00 TST 001`, araç `VEH-TEST-01`.

## Amaç

Telematik sistemlerde her araç birkaç saniyede bir konum gönderir. Müşterinin paketine göre bu veri 7 günden 180 güne kadar farklı sürelerde saklanmalıdır. Proje şu soruların cevabını gözlemleyerek bulmak için yazıldı:

- MongoDB time-series veriyi nasıl yazıyor, bucket'lar nasıl oluşuyor?
- Tek bir koleksiyonda, cihazın paketine göre farklı saklama süreleri (TTL) uygulanabilir mi?
- Cihaz saati bozuksa, mesaj tekrar ya da geç gelirse veri nasıl korunur?
- Ham veri silindikten sonra raporlar ve özetler nasıl yaşamaya devam eder?

## Yapılanlar

| Aşama | İçerik | Sonuç |
| --- | --- | --- |
| **1. Laboratuvar** | `tsdb_gps` veritabanı, 20 sn'lik custom bucket'lar, 30 / 60 / 120 sn TTL | Bucket oluşumu, TTL monitor davranışı ve partial TTL saniyeler içinde gözlemlendi |
| **2. Gerçek yapı** | `gps_tsdb` veritabanı, 20 test cihazı, 6 saklama grubu (`7d` … `180d`) | Tek koleksiyonda genel TTL (180 gün) + her grup için partial TTL indeksi |
| **3. Retention testi** | Geçmiş tarihli ölçümlerle her grubun sınırının denenmesi | Sınır dışındaki ölçümler ilk TTL turunda silindi, içindekiler kaldı |
| **4. Doğrulama kuralları** | Cihaz (C1–C4), zaman (K1–K4) ve konum (G1) kuralları, karantina, tekrar kontrolü | Bozuk veri silinmiyor, sebebiyle birlikte karantinaya ayrılıyor |
| **5. Ingest katmanı** | Node.js ile mesaj işleme, kurulum betiği (`npm run setup`) | Kurulum tekrar çalıştırılabilir ve yanlış kurulumu fark ediyor |
| **6. GPS simülatörü** | 8 senaryo: normal, park, overspeed, offline, geç paket, GPS kaybı, bozuk zaman, tekrar | 20 cihaz, 3 saat, 6780 mesaj birkaç saniyede üretilip kurallardan geçirildi |
| **7. Raporlar** | Saatlik hız, overspeed olayları, çevrimdışı cihazlar, geç paket, GPS kalitesi, karantina | Her senaryo raporda beklenen yerde göründü |
| **8. Geospatial** | GeoJSON + `2dsphere`, `$geoNear`, `$geoWithin` | Bir noktaya yakın ölçümler ve bir bölgeye giren cihazlar bulunuyor |
| **9. Günlük özetler** | `daily_summaries`: km, ortalama/maksimum hız, sürüş süresi, overspeed sayısı | Ham veri silinse de özet 1 ya da 3 yıl kalıyor |
| **10. Testler** | 7 test dosyası, 76 test (unit + integration) | Hepsi geçiyor |

## Öğrenilenler

Denemeler sırasında MongoDB 8 time-series koleksiyonlarında karşılaşılan kısıtlar:

- **Şema doğrulaması (`validator`) kurulamıyor.** Bütün doğrulamanın veriyi yazan kodda yapılması gerekiyor.
- **`meta`'sız belgeler de kabul ediliyor.** Bu belgeler hiçbir partial TTL'ye girmiyor, sessizce genel TTL'ye düşüyor.
- **Otomatik `meta_1_ts_1` indeksi `meta.deviceId` sorgularında kullanılmıyor.** Cihaz bazlı sorgular için `{ 'meta.deviceId': 1, ts: 1 }` indeksi ayrıca kurulmalı.
- **TTL, cihazın gönderdiği `ts`'ye bakıyor.** Bozuk bir cihaz saati verinin hemen silinmesine ya da hiç silinmemesine yol açabiliyor. Zaman kuralları bu yüzden var.
- **`$near` / `$nearSphere` desteklenmiyor.** `$geoNear` ise pipeline'ın ilk aşaması olmalı ve `query` seçeneğini kabul etmiyor, filtre sonradan `$match` ile yapılmalı.
- **Unique indeks yok.** Tekrar kontrolü için ayrı bir normal koleksiyon (`ingest_keys`) gerekiyor.

## Mimari

```
cihaz mesajı ──► ingest ──► kurallar (C1–C4, K1–K4, G1)
                   │
                   ├──► positions              time-series, paket bazlı TTL
                   ├──► positions_quarantine   kurala takılan mesajlar (30 gün)
                   └──► ingest_keys            tekrar kontrolü (7 gün)

positions ──► raporlar          aggregation + geospatial
          └─► daily_summaries   günlük özet (1 / 3 yıl)
```

Dosya dosya ayrıntılar ve kararların nedenleri: [`docs/DOSYALAR.md`](docs/DOSYALAR.md).

## Teknolojiler

- MongoDB 8 (time-series, partial TTL, 2dsphere, aggregation, `$setWindowFields`)
- Node.js 20.19+ ve resmi `mongodb` sürücüsü
- `node:test` ve `mongodb-memory-server` (testler)

## Kurulum

```
npm install
cp .env.example .env
npm run setup
```

`.env` içinde `MONGO_URI` ve `MONGO_DB` doldurulur. `npm run setup` koleksiyonları ve indeksleri kurar. Tekrar çalıştırılabilir.

## Kullanım

`devices` koleksiyonunda aktif cihazlar olmalı.

| Komut | Ne yapar |
| --- | --- |
| `npm run simulate -- --hours 3 --seed 42` | Aktif cihazlar için 3 saatlik GPS verisi üretip yazar |
| `npm run report -- --hours 24` | Son 24 saatin raporları |
| `npm run report -- --near 28.9784,41.0082 --radius 3000` | Bir noktanın çevresindeki ölçümler ve bölgeye giren cihazlar |
| `npm run summarize -- --date 2026-10-07` | O günün özetlerini `daily_summaries`'e yazar |
| `npm test` | Bütün testler. Gerçek veritabanına dokunmaz |

## Proje yapısı

```
config.js       kurallar, saklama grupları, eşikler, koleksiyonlar ve indeksler
env.js          bağlantı ayarları (.env)
setup.js        kurulum
rules.js        doğrulama kuralları
ingest.js       mesaj işleme
geo.js          coğrafi hesaplar
simulator.js    GPS simülatörü
reports.js      raporlar
summaries.js    günlük özetler
test/           unit ve integration testleri
docs/
  DOSYALAR.md   dosya dosya açıklamalar
```

## Sonraki adımlar

- Yük testi: 100 → 1.000 → 10.000 cihaz
- Sensör / CAN verisi (RPM, yakıt seviyesi, sert fren)
- Cihaz–araç atama geçmişi (`device_assignments`)
