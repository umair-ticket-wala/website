// =============================================================
// Umair Ticket Wala — Live Fares API (Vercel function)
// File ka raasta: api/fares.js
//
// Kaam: SerpApi (Google Flights) se kiraya la kar website ko deta hai.
// SerpApi ki key yahan nahi likhi — Vercel ke Environment Variables
// mein "SERPAPI_KEY" naam se rakhi jati hai, taake koi chura na sake.
//
// Misal:
//   /api/fares?from=MUX&to=JED&date=2026-12-10&ret=2026-12-24&adults=1
//   ret na ho to one-way search hoti hai.
//
// Bachat: har jawab Vercel ke CDN par save (cache) hota hai.
//   cache=day  -> 24 ghante (home page ke cards)
//   aam search -> 6 ghante
// Is dauran wahi search dobara ho to SerpApi ki search nahi lagti.
// =============================================================

// Pakistan ke shehar (rawangi) — sirf yahi qubool honge
const FROM_CODES = ["KHI", "LHE", "ISB", "MUX", "SKT", "PEW", "LYP", "UET", "SKZ", "RYK", "DEA", "BHV"];
// Saudi Arabia (manzil)
const TO_CODES = ["JED", "MED"];

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Pakistan ke waqt ke hisaab se aaj ki taareekh (YYYY-MM-DD)
function todayPK() {
  const now = new Date(Date.now() + 5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
}

// SerpApi ke ek flight option ko chhota aur saaf banata hai
function simplify(option) {
  const legs = option.flights || [];
  const first = legs[0] || {};
  const last = legs[legs.length - 1] || {};
  const airlines = [...new Set(legs.map((l) => l.airline).filter(Boolean))];
  return {
    price: typeof option.price === "number" ? option.price : null,
    airlines: airlines,
    logo: option.airline_logo || first.airline_logo || null,
    flightNumbers: legs.map((l) => l.flight_number).filter(Boolean),
    departTime: (first.departure_airport && first.departure_airport.time) || null,
    arriveTime: (last.arrival_airport && last.arrival_airport.time) || null,
    from: (first.departure_airport && first.departure_airport.id) || null,
    to: (last.arrival_airport && last.arrival_airport.id) || null,
    durationMin: option.total_duration || null,
    stops: Math.max(0, legs.length - 1),
    via: (option.layovers || []).map((l) => l.id).filter(Boolean)
  };
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
  }

  const q = req.query || {};
  const from = String(q.from || "").toUpperCase();
  const to = String(q.to || "").toUpperCase();
  const date = String(q.date || "");
  const ret = q.ret ? String(q.ret) : "";
  const adults = parseInt(q.adults || "1", 10);
  const longCache = String(q.cache || "") === "day";

  // ---- Input ki jaanch ----
  const today = todayPK();
  let problem = null;
  if (!FROM_CODES.includes(from)) problem = "Unknown departure city";
  else if (!TO_CODES.includes(to)) problem = "Unknown destination";
  else if (!isValidDate(date)) problem = "Invalid departure date";
  else if (daysBetween(today, date) < 1) problem = "Departure date must be in the future";
  else if (daysBetween(today, date) > 330) problem = "Departure date is too far ahead";
  else if (ret && (!isValidDate(ret) || daysBetween(date, ret) < 1 || daysBetween(date, ret) > 60)) problem = "Invalid return date";
  else if (!(adults >= 1 && adults <= 9)) problem = "Travellers must be between 1 and 9";

  if (problem) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: problem }));
  }

  const key = process.env.SERPAPI_KEY;
  if (!key) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: "Server is not configured" }));
  }

  // ---- SerpApi se poochna ----
  const params = new URLSearchParams({
    engine: "google_flights",
    departure_id: from,
    arrival_id: to,
    outbound_date: date,
    type: ret ? "1" : "2", // 1 = return, 2 = one-way
    currency: "PKR",
    gl: "pk",
    hl: "en",
    adults: String(adults),
    api_key: key
  });
  if (ret) params.set("return_date", ret);

  try {
    const r = await fetch("https://serpapi.com/search.json?" + params.toString());
    const data = await r.json();

    if (!r.ok || data.error) {
      // "No results" ko masla na samjhein — bas khaali list
      const msg = String(data.error || "Fare service error");
      if (/hasn't returned any results/i.test(msg)) {
        res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=3600");
        return res.end(JSON.stringify({ ok: true, from, to, date, ret: ret || null, adults, flights: [], lowest: null, checkedAt: new Date().toISOString() }));
      }
      res.statusCode = 502;
      res.setHeader("Cache-Control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "Live fares are unavailable right now" }));
    }

    const all = [...(data.best_flights || []), ...(data.other_flights || [])]
      .map(simplify)
      .filter((f) => f.price !== null)
      .sort((a, b) => a.price - b.price)
      .slice(0, 6);

    const insights = data.price_insights || {};
    const body = {
      ok: true,
      from, to, date, ret: ret || null, adults,
      lowest: all.length ? all[0].price : (insights.lowest_price || null),
      priceLevel: insights.price_level || null,            // low / typical / high
      typicalRange: insights.typical_price_range || null,  // [kam, zyada]
      flights: all,
      checkedAt: new Date().toISOString()
    };

    const seconds = longCache ? 86400 : 21600;
    res.setHeader("Cache-Control", "public, s-maxage=" + seconds + ", stale-while-revalidate=3600");
    return res.end(JSON.stringify(body));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: "Live fares are unavailable right now" }));
  }
};
