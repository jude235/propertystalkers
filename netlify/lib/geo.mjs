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

export function makeGeo({ apiKey, fetchImpl = fetch }) {
  async function geocode(address) {
    const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    u.searchParams.set("address", address);
    u.searchParams.set("region", "in");
    u.searchParams.set("components", "country:IN");
    u.searchParams.set("key", apiKey);
    const res = await fetchImpl(u.toString());
    const d = await res.json();
    if (d.status === "OK" && d.results && d.results.length) return d.results[0];
    if (d.status === "ZERO_RESULTS") return null;
    throw new Error(`Geocoding failed: ${d.status} ${d.error_message || ""}`);
  }

  return {
    /** Returns { lat, lng, precision, address, place_id } or null if it can't be placed. */
    async locate({ building, locality, city }) {
      const attempts = [];
      if (building) attempts.push([building, locality, city]);
      if (locality) attempts.push([locality, city]);
      for (const parts of attempts) {
        const r = await geocode(parts.filter(Boolean).join(", ") + ", India");
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
