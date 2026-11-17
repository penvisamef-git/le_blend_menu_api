// Image storage on Cloudflare R2 (S3-compatible) — replaces Cloudinary.
// Needs in .env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL
// Optional:      STORAGE_FOLDER (default: CLOUDINARY_FOLDER or "le_blend")
// Same functions / return shape as the old util/cloudinary.js, so routes and saved data keep working:
//   uploadBuffer(file, subFolder) → { url, public_id, resource_type, format, width, height, bytes, original_name }
const crypto = require("crypto");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");

const BUCKET = process.env.R2_BUCKET;
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
const BASE_FOLDER = process.env.STORAGE_FOLDER || process.env.CLOUDINARY_FOLDER || "le_blend";

const client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
});

const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };

// multer (busboy) reads names as latin1 → fix to UTF-8 only when that gives a valid result
function fixFileName(name = "") {
  const utf8 = Buffer.from(name, "latin1").toString("utf8");
  return utf8.includes("�") ? name : utf8;
}

// width / height from the file header (png, jpg, gif, webp) — no extra library
function imageSize(buf) {
  try {
    if (buf.slice(1, 4).toString() === "PNG") return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf.slice(0, 3).toString() === "GIF") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") {
      const type = buf.slice(12, 16).toString();
      if (type === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (type === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (type === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* unknown format */
  }
  return { width: null, height: null };
}

const slug = (s) =>
  String(s || "image")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "image";

// Upload one file buffer (from multer memoryStorage) → file info to save in DB
async function uploadBuffer(file, subFolder = "menu") {
  const originalName = fixFileName(file.originalname);
  const dot = originalName.lastIndexOf(".");
  const ext = (dot > 0 ? originalName.slice(dot + 1) : "jpg").toLowerCase();
  const base = dot > 0 ? originalName.slice(0, dot) : originalName;
  const key = `${BASE_FOLDER}/${subFolder}/${slug(base)}_${crypto.randomBytes(4).toString("hex")}.${ext}`;

  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype || MIME[ext] || "application/octet-stream",
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  const { width, height } = imageSize(file.buffer);
  return {
    url: `${PUBLIC_URL}/${key}`,
    public_id: key,
    resource_type: "image",
    format: ext,
    width,
    height,
    bytes: file.buffer.length,
    original_name: originalName,
  };
}

// Delete a file by its key (= public_id)
async function deleteFile(public_id) {
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: public_id }));
  return { result: "ok" };
}

// Direct browser upload is not used with R2 (uploads go through POST /upload)
function signUpload() {
  return null;
}

async function ping() {
  await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
  return { status: "ok", bucket: BUCKET, public_url: PUBLIC_URL };
}

// Total size of everything in the bucket (real numbers, from R2 itself).
// Cached for 10 minutes so the dashboard doesn't list the bucket on every visit.
let usageCache = null;
async function usage({ fresh = false } = {}) {
  if (!fresh && usageCache && Date.now() - usageCache.at < 10 * 60 * 1000) return usageCache.data;
  let bytes = 0;
  let objects = 0;
  const byFolder = {};
  let ContinuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken, MaxKeys: 1000 }));
    for (const o of page.Contents || []) {
      bytes += o.Size || 0;
      objects++;
      const folder = o.Key.split("/").slice(0, -1).pop() || "/";
      byFolder[folder] = byFolder[folder] || { bytes: 0, objects: 0 };
      byFolder[folder].bytes += o.Size || 0;
      byFolder[folder].objects++;
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);

  const limitGb = Number(process.env.STORAGE_PLAN_LIMIT_GB) > 0 ? Number(process.env.STORAGE_PLAN_LIMIT_GB) : 10;
  const data = {
    provider: "Cloudflare R2",
    bucket: BUCKET,
    bytes,
    objects,
    by_folder: byFolder,
    limit_bytes: Math.round(limitGb * 1024 ** 3),
    checked_at: new Date().toISOString(),
  };
  usageCache = { at: Date.now(), data };
  return data;
}

module.exports = { uploadBuffer, deleteFile, signUpload, ping, usage, BASE_FOLDER };
