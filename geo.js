const EARTH_RADIUS_METERS = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

export const isValidPoint = (location) =>
    location?.type === 'Point' &&
    Array.isArray(location.coordinates) &&
    location.coordinates.length === 2 &&
    location.coordinates.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    Math.abs(location.coordinates[0]) <= 180 &&
    Math.abs(location.coordinates[1]) <= 90;

export const haversineMeters = ([lon1, lat1], [lon2, lat2]) => {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

export const movePoint = ([lon, lat], headingDeg, meters) => {
    const d = meters / EARTH_RADIUS_METERS;
    const h = toRad(headingDeg);
    const lat1 = toRad(lat);
    const lon1 = toRad(lon);
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(h));
    const lon2 = lon1 + Math.atan2(Math.sin(h) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return [((toDeg(lon2) + 540) % 360) - 180, toDeg(lat2)];
}
