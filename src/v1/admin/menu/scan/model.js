const mongoose = require("mongoose");

// One document per day (Asia/Phnom_Penh) — counts only, no personal data.
//   opens    : every time the public menu is opened
//   visitors : each browser counted once per day
//   qr       : opens that came from the QR code (?src=qr)
const scanDailySchema = new mongoose.Schema(
  {
    day: { type: String, required: true, unique: true }, // "2026-11-18"
    opens: { type: Number, default: 0 },
    visitors: { type: Number, default: 0 },
    qr: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);

module.exports = mongoose.model("Menu_Scan_Daily", scanDailySchema);
