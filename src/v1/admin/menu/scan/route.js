const ScanModel = require("./model");
const baseRoute = "menu/scan-stats";

// "YYYY-MM-DD" in Cambodia time
const dayKey = (d = new Date()) => new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// Menu scan statistics for the dashboard
const route = (prop) => {
  const urlAPI = `/${prop.main_route}/${baseRoute}`;
  const guardRead = [prop.api_auth, prop.jwt_auth, prop.request_user];

  // GET /menu/scan-stats?group=day|month|year
  //   day   → last 30 days, month → last 12 months, year → every year
  //   → { totals: { today, month, year, all }, series: [{ key, opens, visitors, qr }] }
  prop.app.get(`${urlAPI}`, ...guardRead, async (req, res) => {
    try {
      const group = ["day", "month", "year"].includes(req.query.group) ? req.query.group : "day";
      const today = dayKey();
      const len = { day: 10, month: 7, year: 4 }[group];

      // keys of the period (so days with 0 scans still show)
      const keys = [];
      if (group === "day") {
        for (let i = 29; i >= 0; i--) keys.push(dayKey(new Date(Date.now() - i * 86400000)));
      } else if (group === "month") {
        const [y, m] = today.split("-").map(Number);
        for (let i = 11; i >= 0; i--) {
          const d = new Date(Date.UTC(y, m - 1 - i, 1));
          keys.push(d.toISOString().slice(0, 7));
        }
      }

      const from = group === "year" ? "0000" : keys[0];
      const rows = await ScanModel.aggregate([
        { $match: { day: { $gte: from } } },
        {
          $group: {
            _id: { $substrCP: ["$day", 0, len] },
            opens: { $sum: "$opens" },
            visitors: { $sum: "$visitors" },
            qr: { $sum: "$qr" },
          },
        },
        { $sort: { _id: 1 } },
      ]);
      const byKey = Object.fromEntries(rows.map((r) => [r._id, r]));
      const allKeys = group === "year" ? (rows.length ? rows.map((r) => r._id) : [today.slice(0, 4)]) : keys;
      const series = allKeys.map((key) => ({
        key,
        opens: byKey[key]?.opens || 0,
        visitors: byKey[key]?.visitors || 0,
        qr: byKey[key]?.qr || 0,
      }));

      const sumFrom = async (prefix) => {
        const [r] = await ScanModel.aggregate([
          { $match: prefix ? { day: { $regex: `^${prefix}` } } : {} },
          { $group: { _id: null, opens: { $sum: "$opens" }, visitors: { $sum: "$visitors" }, qr: { $sum: "$qr" } } },
        ]);
        return { opens: r?.opens || 0, visitors: r?.visitors || 0, qr: r?.qr || 0 };
      };
      const [t, m, y, all] = await Promise.all([
        sumFrom(today),
        sumFrom(today.slice(0, 7)),
        sumFrom(today.slice(0, 4)),
        sumFrom(""),
      ]);

      res.json({ success: true, data: { group, today, totals: { today: t, month: m, year: y, all }, series } });
    } catch (err) {
      res.status(500).json({ success: false, message: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!", error: err.message });
    }
  });
};

module.exports = route;
module.exports.dayKey = dayKey;
