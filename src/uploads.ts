import { mkdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { env } from "./config.js";

const uploadDir = resolve(process.cwd(), "public/uploads/logos");

const allowedMimeTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"]
]);

await mkdir(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const extension = allowedMimeTypes.get(file.mimetype) ?? extname(file.originalname).toLowerCase();
    cb(null, randomUUID() + extension);
  }
});

export const logoUpload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1
  },
  fileFilter: (_req, file, cb) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      cb(new Error("Unsupported logo format. Use JPG, PNG or WebP."));
      return;
    }
    cb(null, true);
  }
});

export function publicUploadUrl(req: { protocol: string; get(name: string): string | undefined }, filename: string) {
  const baseUrl = env.PUBLIC_BASE_URL?.replace(/\/+$/, "") ?? `${req.protocol}://${req.get("host")}`;
  return `${baseUrl}/uploads/logos/${encodeURIComponent(filename)}`;
}
