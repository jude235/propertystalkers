// Turns "Skyview, Sector 7, Gurugram" into a point on the map using Google's Geocoding API.

const BUILDING_TYPES = ["premise", "subpremise", "establishment", "point_of_interest", "street_address"];
const AREA_TYPES = ["sublocality", "sublocality_level_1", "sublocality_level_2", "sublocality_level_3",
  "neighborhood", "route", "postal_code", "colloquial_area", "intersection", "natural_feature", "park"];

export function precisionOf(result) {
  const t = result.types || [];
  if (t.some((x) => BUILDING_TYPES.includes(x))) return "building";
  if (t.some((x) => AREA_TYPES.includes(x))) return "area";
  return "city"; // too vague to pin a property
}

/** Coordinates written in a Google Maps URL: @lat,lng / !3dlat!4dlng / q=lat,lng / ll= / query= / destination=. */
export function coordsFromMapsUrl(u) {
  const s = decodeURIComponent(String(u || ""));
  const pats = [/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/, /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,
    /[?&](?:q|ll|query|destination|center)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/];
  for (const re of pats) {
    const m = s.match(re);
    if (m) {
      const lat = +m[1], lng = +m[2];
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng)) return { lat, lng };
    }
  }
  return null;
}

export function makeGeo({ apiKey, fetchImpl = fetch }) {
  async function geocode(address) {
    const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    u.searchParams.set("address", address);
    u.searchParams.set("key", apiKey);
    const res = await fetchImpl(u.toString());
    const d = await res.json();
    if (d.status === "OK" && d.results && d.results.length) return d.results[0];
    if (d.status === "ZERO_RESULTS") return null;
    throw new Error(`Geocoding failed: ${d.status} ${d.error_message || ""}`);
  }

  return {
    /** Exact pin from a Google Maps link; short maps.app.goo.gl links are followed (two hops at most). */
    async pinFromLink(link) {
      let u = link;
      for (let hop = 0; hop < 3; hop++) {
        const c = coordsFromMapsUrl(u);
        if (c) return c;
        if (!/^https:\/\/(maps\.app\.goo\.gl|goo\.gl)\//i.test(u) && hop > 0) break;
        try {
          const res = await fetchImpl(u, { redirect: "manual" });
          const next = res.headers.get("location");
          if (!next) break;
          u = next;
        } catch { break; }
      }
      return null;
    },
    /** Pin dropped on the map -> address, area, city and country (for filling in a listing). */
    async reverse(lat, lng) {
      const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
      u.searchParams.set("latlng", `${lat},${lng}`);
      u.searchParams.set("key", apiKey);
      const d = await (await fetchImpl(u.toString())).json();
      if (d.status !== "OK" || !d.results || !d.results.length) return null;
      const comps = d.results.flatMap((r) => r.address_components || []);
      const find = (...types) => { const c = comps.find((x) => types.some((t) => (x.types || []).includes(t))); return c ? c.long_name : null; };
      return {
        address: d.results[0].formatted_address,
        locality: find("sublocality_level_1", "sublocality", "neighborhood", "colloquial_area"),
        city: find("locality", "postal_town", "administrative_area_level_2", "administrative_area_level_1"),
        country: find("country")
      };
    },
    /** For the search bar: any place name -> centre and viewport, or null. */
    async search(q) {
      const r = await geocode(q);
      if (!r) return null;
      const v = r.geometry.viewport;
      return {
        lat: r.geometry.location.lat,
        lng: r.geometry.location.lng,
        address: r.formatted_address,
        viewport: v ? { north: v.northeast.lat, east: v.northeast.lng, south: v.southwest.lat, west: v.southwest.lng } : null
      };
    },

    /** Returns { lat, lng, precision, address, place_id } or null if it can't be placed. */
    async locate({ building, locality, city, country }) {
      const attempts = [];
      if (building) attempts.push([building, locality, city, country]);
      if (building && locality) attempts.push([building, city, country]);
      if (locality) attempts.push([locality, city, country]);
      for (const parts of attempts) {
        const r = await geocode(parts.filter(Boolean).join(", "));
        if (!r) continue;
        let precision = precisionOf(r);
        if (precision === "city") continue;
        // A building search that only matched the sector is an area pin.
        if (precision === "building" && !building) precision = "area";
        return {
          lat: r.geometry.location.lat,
          lng: r.geometry.location.lng,
          precision,
          address: r.formatted_address,
          place_id: precision === "building" ? r.place_id : null
        };
      }
      return null;
    }
  };
}
