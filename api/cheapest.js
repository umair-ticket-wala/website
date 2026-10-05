// =============================================================
// Umair Ticket Wala — Cheapest Days API (Vercel function)
// File ka raasta: api/cheapest.js
//
// Kaam: Travelpayouts (Aviasales) se ek mahine ke har din ka sab se
// sasta ONE-WAY kiraya laata hai (jo musafiron ne haal hi mein dekha).
// Ye bilkul free hai. Pakka/live rate SerpApi wala /api/fares deta hai.
//
// Token yahan nahi likha — Vercel ke Environment Variables mein
// "TRAVELPAYOUTS_TOKEN" naam se rakha hai.
//
// Misal: /api/cheapest?from=MUX&to=JED&month=2026-12
// Jawab 6 ghante tak CDN par save rehta hai.
// =============================================================

const FROM_CODES = ["KHI", "LHE", "ISB", "MUX", "SKT", "PEW", "LYP", "UET", "SKZ", "RYK", "DEA", "BHV"];
const TO_CODES = ["JED", "MED"];

// Airline code -> naam (jo na ho us ka code hi dikhega)
const AIRLINES = {
  PK: "PIA", PA: "Airblue", PF: "AirSial", ER: "SereneAir", "9P": "Fly Jinnah",
  SV: "Saudia", XY: "flynas", F3: "flyadeal", EK: "Emirates", QR: "Qatar Airways",
  EY: "Etihad", G9: "Air Arabia", FZ: "flydubai", OV: "SalamAir", WY: "Oman Air",
  GF: "Gulf Air", J9: "Jazeera Airways", KU: "Kuwait Airways", TK: "Turkish Airlines"
};

function thisMonthPK() {
  return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 7);
}
function monthsBetween(a, b) {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const q = req.query || {};
  const from = String(q.from || "").toUpperCase();
  const to = String(q.to || "").toUpperCase();
  const month = String(q.month || "");

  let problem = null;
  if (!FROM_CODES.includes(from)) problem = "Unknown departure city";
  else if (!TO_CODES.includes(to)) problem = "Unknown destination";
  else if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) problem = "Invalid month";
  else {
    const diff = monthsBetween(thisMonthPK(), month);
    if (diff < 0 || diff > 11) problem = "Month must be within the next 12 months";
  }
  if (problem) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: problem }));
  }

  const token = process.env.TRAVELPAYOUTS_TOKEN;
  if (!token) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: "Server is not configured" }));
  }

  const params = new URLSearchParams({
    origin: from,
    destination: to,
    departure_at: month,
    group_by: "departure_at",
    currency: "pkr",
    token: token
  });

  try {
    const r = await fetch("https://api.travelpayouts.com/aviasales/v3/grouped_prices?" + params.toString());
    const data = await r.json();
    if (!r.ok || data.success === false) {
      res.statusCode = 502;
      res.setHeader("Cache-Control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "Cheapest dates are unavailable right now" }));
    }

    const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
    const days = Object.keys(data.data || {})
      .filter((d) => d > today) // sirf aane wale din
      .map((d) => {
        const x = data.data[d];
        return {
          date: d,
          price: x.price,
          airline: AIRLINES[x.airline] || x.airline || "",
          stops: typeof x.transfers === "number" ? x.transfers : null,
          durationMin: x.duration || null
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    const cheapest = days.reduce((m, d) => (m === null || d.price < m ? d.price : m), null);

    res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=3600");
    return res.end(JSON.stringify({ ok: true, from, to, month, cheapest, days }));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: "Cheapest dates are unavailable right now" }));
  }
};
