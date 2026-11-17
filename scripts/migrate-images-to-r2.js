// Moves every image that still points to Cloudinary over to Cloudflare R2 and saves the new link.
// Source of each file: 1) local original in scripts/data/images/<ITEM CODE>.jpg  2) download from Cloudinary.
// Images that can't be fetched (e.g. Cloudinary account disabled, no local file) are listed at the end.
// Safe to run again: images already on R2 are skipped.
// Usage: node scripts/migrate-images-to-r2.js [--dry]
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("../src/util/db");
const { uploadBuffer } = require("../src/util/storage");

const DRY = process.argv.includes("--dry");
const LOCAL = path.join(__dirname, "data", "images");
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

// [model, image field, folder, label]
const TARGETS = [
  ["../src/v1/admin/menu/item/model", "image", "menu", (d) => d.code],
  ["../src/v1/admin/menu/category/model", "icon", "category", (d) => `category ${d.code}`],
  ["../src/v1/admin/menu/banner/model", "image", "banner", (d) => `banner ${d.title || d._id}`],
  ["../src/v1/admin/menu/book/model", "cover", "menu", (d) => `book ${d.code}`],
  ["../src/v1/admin/menu/setting/model", "logo", "setting", () => "restaurant logo"],
];

async function getBuffer(doc, field, url) {
  if (doc.code && field === "image") {
    for (const ext of ["jpg", "jpeg", "png", "webp"]) {
      const p = path.join(LOCAL, `${String(doc.code).toUpperCase()}.${ext}`);
      if (fs.existsSync(p)) return { buffer: fs.readFileSync(p), name: path.basename(p), from: "local" };
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Cloudinary ${res.status} ${res.headers.get("x-cld-error") || ""}`.trim());
  const name = decodeURIComponent(url.split("/").pop().split("?")[0]);
  return { buffer: Buffer.from(await res.arrayBuffer()), name, from: "cloudinary" };
}

async function run() {
  await connectDB();
  const stat = { moved: 0, alreadyR2: 0, failed: 0 };
  const failed = [];

  for (const [modelPath, field, folder, label] of TARGETS) {
    const Model = require(modelPath);
    const docs = await Model.find({ [`${field}.url`]: { $exists: true, $ne: "" } }).lean();
    for (const doc of docs) {
      const url = doc[field].url;
      if (PUBLIC_URL && url.startsWith(PUBLIC_URL)) {
        stat.alreadyR2++;
        continue;
      }
      try {
        if (DRY) {
          const local = doc.code && field === "image" && fs.existsSync(path.join(LOCAL, `${String(doc.code).toUpperCase()}.jpg`));
          console.log(`  would move ${label(doc)} (${local ? "local file" : "from Cloudinary"})`);
          stat.moved++;
          continue;
        }
        const file = await getBuffer(doc, field, url);
        const image = await uploadBuffer({ buffer: file.buffer, originalname: file.name }, folder);
        if (doc[field].original_name) image.original_name = doc[field].original_name;
        await Model.updateOne({ _id: doc._id }, { [field]: image });
        stat.moved++;
        console.log(`  ✓ ${label(doc)} (${file.from})`);
      } catch (err) {
        stat.failed++;
        failed.push(`${label(doc)}: ${err.message}`);
      }
    }
  }

  console.log(DRY ? "🔎 DRY RUN" : "✅ Done", stat);
  if (failed.length) console.log("Not moved (re-upload in admin, or re-run after Cloudinary works):\n  " + failed.join("\n  "));
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error("❌ Failed:", err.message);
  await mongoose.connection.close();
  process.exit(1);
});
