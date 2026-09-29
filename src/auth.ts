import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { query } from "./db.js";
import { env } from "./config.js";
import type { NextFunction, Request, Response } from "express";

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(72)
});

function requireJwtSecret() {
  if (!env.JWT_SECRET) throw new Error("JWT_SECRET is not configured");
  return env.JWT_SECRET;
}

function createToken(userId: string) {
  return jwt.sign({ sub: userId }, requireJwtSecret(), { algorithm: "HS256", expiresIn: "7d" });
}

export async function registerUser(input: unknown) {
  const parsed = credentialsSchema.parse(input);
  const existing = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [parsed.email]);
  if (existing.rowCount) throw new Error("EMAIL_ALREADY_REGISTERED");

  const passwordHash = await bcrypt.hash(parsed.password, 12);
  const userId = randomUUID();
  const result = await query<{ id: string; email: string; created_at: string }>(
    "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email, created_at",
    [userId, parsed.email, passwordHash]
  );

  return { user: result.rows[0], token: createToken(userId) };
}

export async function loginUser(input: unknown) {
  const parsed = credentialsSchema.parse(input);
  const result = await query<{ id: string; email: string; password_hash: string; created_at: string }>(
    "SELECT id, email, password_hash, created_at FROM users WHERE email = $1",
    [parsed.email]
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(parsed.password, user.password_hash))) {
    throw new Error("INVALID_CREDENTIALS");
  }

  return {
    user: { id: user.id, email: user.email, created_at: user.created_at },
    token: createToken(user.id)
  };
}

export function authRequired(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ ok: false, error: "Authentication required" });
    return;
  }

  try {
    const payload = jwt.verify(token, requireJwtSecret(), { algorithms: ["HS256"] });
    if (typeof payload === "string" || typeof payload.sub !== "string" || !payload.sub) {
      res.status(401).json({ ok: false, error: "Invalid authentication token" });
      return;
    }
    res.locals.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ ok: false, error: "Invalid or expired authentication token" });
  }
}
